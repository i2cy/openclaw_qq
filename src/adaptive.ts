// adaptive.ts — 群聊自适应触发(2026-09-27, dad)
//
// 目标: 白名单群里无需 @/关键词,由轻量 LLM(judge)根据人格+判据+滚动窗口
// 决定是否"主动插嘴"。决策为"是"时,把选中消息(含真实图片/回复链/昵称/时间)
// 组合成合成 inbound 事件重入现有消息管线,复用全部投递机器(session queue、
// interruptOnNewMessage 打断、合并转发、typing card……@提及路径完全不受影响)。
//
// 关键约束:
// - 窗口: 每群滚动保留,≥minDays 且 ≤maxMessages(硬顶 hardCap),持久化到插件状态目录
// - 冷却: 两次判定之间 cooldownMs;实际发出回复后 replyCooldownMs
// - 静默时段: quietHours 内不判定(@提及照常)
// - 去重: 已注入会话的消息(injected 标记)永不重复注入
// - REPLYING 期间: 窗口继续记录但不判定;回合完成后若有排队的合格消息,打包再判一次
// - judge 失败(网络/格式重试耗尽): 静默放弃本轮,绝不阻塞正常路径
import fs from "node:fs";
import path from "node:path";
import type { OneBotEvent } from "./types.js";

// ───────────────────────── types ─────────────────────────

export type AdaptiveMediaRef = { path: string; type: string };

export type AdaptiveWindowEntry = {
    seq: number;
    messageId: string;
    ts: number;                 // ms epoch
    userId: string;
    nickname: string;
    text: string;               // 已渲染文本(截断存储)
    replyToSeq?: number;        // 回复的窗口内消息 seq
    imageCount: number;
    media?: AdaptiveMediaRef[]; // 记录时缓存到本地的图片
    injected?: boolean;
    self?: boolean;             // Cody 自己的发言镜像
};

type WindowFile = { nextSeq: number; entries: AdaptiveWindowEntry[] };

type GroupPhase = "idle" | "debounce" | "judging" | "replying";

type GroupState = {
    phase: GroupPhase;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    pendingTriggerSeq: number | null;
    queuedDuringReply: number[];   // REPLYING 期间到达的合格消息 seq
    evalsThisHour: number;
    hourStamp: number;
    lastEvalAt: number;
    lastReplyAt: number;
    replyingSince: number;         // 看门狗:REPLYING 卡死自愈
};

const REPLYING_WATCHDOG_MS = 15 * 60 * 1000;

export type AdaptiveOverride = {
    contextBlock: string;
    mediaEntries: Array<{ url: string; path: string; type: string }>;
    syntheticId: string;
};

export type AdaptiveAccountConfig = {
    enabled: boolean;
    groups: Set<string>;
    adminsOnly: boolean;
    admins: string[];
    recordScope: "all" | "admins";
    windowMaxMessages: number;
    windowMinDays: number;
    windowHardCap: number;
    cooldownMs: number;
    replyCooldownMs: number;
    debounceMs: number;
    judgeTimeoutMs: number;
    judgeMaxRetries: number;
    judgeModel: string;          // "provider/model"
    criteria: string;            // 配置字符串(空 → 用引导存档/触发引导)
    quietStart: string | null;   // "HH:MM"
    quietEnd: string | null;
    dryRun: boolean;
    trace: boolean;
    maxPerHour: number;
    notifyUser: string;          // 引导完成通知对象(第一个 admin)
    adminOnlyChat: boolean;      // 该模式下非 admin 触发的注入会被正常路径拦掉,直接不触发
    selfId: string;
};

type SenderHooks = {
    sendPrivate: (userId: string, text: string) => void;
};

type Invoker = (event: OneBotEvent, override: AdaptiveOverride) => Promise<void>;

// ───────────────────────── module state ─────────────────────────

const DEFAULT_JUDGE_MODEL = "dgx-spark/qwen3.8-flash-next";
const STATE_DIR = process.env.QQ_ADAPTIVE_STATE_DIR
    || path.join(process.env.HOME || "/tmp", ".openclaw", "extensions", "qq", "state", "adaptive");
const AUDIT_LOG = "/tmp/qq_adaptive.log";
const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ENTRY_TEXT_CAP = 2000;       // 窗口条目存储截断
const JUDGE_LINE_CAP = 300;        // judge 上下文单条截断

const configs = new Map<string, AdaptiveAccountConfig>();   // accountId → cfg
const windows = new Map<string, WindowFile>();              // groupKey → window
const states = new Map<string, GroupState>();               // groupKey → fsm
const senders = new Map<string, SenderHooks>();
const invokers = new Map<string, Invoker>();
const syntheticOverrides = new Map<string, AdaptiveOverride>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

let personaCache: { files: Record<string, string>; mtimes: Record<string, number>; loadedAt: number } | null = null;
let bootstrapInFlight = false;
let judgeInFlight = 0;

const gkey = (accountId: string, groupId: string) => `${accountId}:${groupId}`;

function nowMs(): number { return Date.now(); }

function cfgFor(accountId: string): AdaptiveAccountConfig | undefined {
    return configs.get(accountId);
}

// ───────────────────────── logging ─────────────────────────

function alog(line: string) {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(`[QQAdaptive] ${line}`);
    try {
        const st = fs.statSync(AUDIT_LOG);
        if (st.size > AUDIT_LOG_MAX_BYTES) fs.writeFileSync(AUDIT_LOG, "");
    } catch { /* absent is fine */ }
    try { fs.appendFileSync(AUDIT_LOG, stamped + "\n"); } catch { /* best effort */ }
}

function traceLog(accountId: string, line: string) {
    const cfg = cfgFor(accountId);
    if (cfg?.trace) alog(line);
    else console.log(`[QQAdaptive:trace] ${line}`);
}

// ───────────────────────── persistence ─────────────────────────

function windowPath(groupKey: string): string {
    return path.join(STATE_DIR, `window_${groupKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function metaPath(): string { return path.join(STATE_DIR, "meta.json"); }

function ensureStateDir() {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }
}

function readMeta(): Record<string, any> {
    try { return JSON.parse(fs.readFileSync(metaPath(), "utf8")); } catch { return {}; }
}

function writeMeta(patch: Record<string, any>) {
    ensureStateDir();
    const meta = { ...readMeta(), ...patch };
    const tmp = metaPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, metaPath());
}

function loadWindow(groupKey: string): WindowFile {
    const cached = windows.get(groupKey);
    if (cached) return cached;
    let wf: WindowFile = { nextSeq: 1, entries: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(windowPath(groupKey), "utf8"));
        if (parsed && Array.isArray(parsed.entries)) {
            wf = { nextSeq: Number(parsed.nextSeq) || parsed.entries.length + 1, entries: parsed.entries };
        }
    } catch { /* first run */ }
    windows.set(groupKey, wf);
    return wf;
}

function persistWindow(groupKey: string) {
    const existing = persistTimers.get(groupKey);
    if (existing) clearTimeout(existing);
    persistTimers.set(groupKey, setTimeout(() => {
        persistTimers.delete(groupKey);
        try {
            ensureStateDir();
            const wf = windows.get(groupKey);
            if (!wf) return;
            const tmp = windowPath(groupKey) + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify({ groupKey, nextSeq: wf.nextSeq, entries: wf.entries }));
            fs.renameSync(tmp, windowPath(groupKey));
        } catch (e: any) {
            console.warn(`[QQAdaptive] window persist failed ${groupKey}: ${String(e?.message ?? e)}`);
        }
    }, 1500));
}

function getState(groupKey: string): GroupState {
    let st = states.get(groupKey);
    if (!st) {
        st = {
            phase: "idle", debounceTimer: null, pendingTriggerSeq: null,
            queuedDuringReply: [], evalsThisHour: 0, hourStamp: 0,
            lastEvalAt: 0, lastReplyAt: 0, replyingSince: 0,
        };
        states.set(groupKey, st);
    }
    return st;
}

// ───────────────────────── config / attach ─────────────────────────

export function adaptiveConfigure(accountId: string, raw: Record<string, any>, opts: { adminIds: Array<string | number>; selfIdGetter: () => string | number | undefined }) {
    const groups = parseIdSet(raw.adaptiveGroups);
    const quiet = parseQuietHours(String(raw.adaptiveQuietHours ?? "23:30-08:00"));
    const adminIds = opts.adminIds.map((x) => String(x));
    const cfg: AdaptiveAccountConfig = {
        enabled: groups.size > 0,
        groups,
        adminsOnly: Boolean(raw.adaptiveAdminsOnly),
        admins: adminIds,
        recordScope: String(raw.adaptiveRecordScope ?? "all").toLowerCase() === "admins" ? "admins" : "all",
        windowMaxMessages: Math.max(5, Number(raw.adaptiveWindowMaxMessages ?? 60)),
        windowMinDays: Math.max(0.5, Number(raw.adaptiveWindowMinDays ?? 2)),
        windowHardCap: Math.max(20, Number(raw.adaptiveWindowHardCap ?? 300)),
        cooldownMs: Math.max(5000, Number(raw.adaptiveCooldownMs ?? 120000)),
        replyCooldownMs: Math.max(5000, Number(raw.adaptiveReplyCooldownMs ?? 600000)),
        debounceMs: Math.max(1000, Number(raw.adaptiveDebounceMs ?? 8000)),
        judgeTimeoutMs: Math.max(5000, Number(raw.adaptiveJudgeTimeoutMs ?? 60000)),
        judgeMaxRetries: Math.max(0, Number(raw.adaptiveJudgeMaxRetries ?? 3)),
        judgeModel: String(raw.adaptiveJudgeModel ?? "").trim() || DEFAULT_JUDGE_MODEL,
        criteria: String(raw.adaptiveReplyCriteria ?? "").trim(),
        quietStart: quiet?.start ?? null,
        quietEnd: quiet?.end ?? null,
        dryRun: Boolean(raw.adaptiveDryRun),
        trace: Boolean(raw.adaptiveTrace),
        maxPerHour: Math.max(1, Number(raw.adaptiveMaxPerHour ?? 20)),
        notifyUser: adminIds[0] ?? "",
        adminOnlyChat: Boolean(raw.adminOnlyChat),
        get selfId() { return String(opts.selfIdGetter() ?? ""); },
    } as AdaptiveAccountConfig;
    configs.set(accountId, cfg);
    if (cfg.enabled) alog(`configured account=${accountId} groups=[${[...cfg.groups].join(",")}] judge=${cfg.judgeModel} dryRun=${cfg.dryRun} adminsOnly=${cfg.adminsOnly} quiet=${cfg.quietStart ?? "-"}-${cfg.quietEnd ?? "-"}`);
    return cfg;
}

export function attachSender(accountId: string, hooks: SenderHooks) { senders.set(accountId, hooks); }
export function attachInvoker(accountId: string, fn: Invoker) { invokers.set(accountId, fn); }

export function isAdaptiveGroup(accountId: string, groupId: string | number): boolean {
    const cfg = cfgFor(accountId);
    return Boolean(cfg?.enabled && cfg.groups.has(String(groupId)));
}

function parseIdSet(v: unknown): Set<string> {
    const out = new Set<string>();
    if (!v) return out;
    const parts = Array.isArray(v) ? v : String(v).split(/[,;\s]+/);
    for (const p of parts) {
        const t = String(p ?? "").trim();
        if (t) out.add(t);
    }
    return out;
}

function parseQuietHours(raw: string): { start: string; end: string } | null {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(raw ?? "");
    if (!m) return null;
    const norm = (h: string, mi: string) => `${String(Math.min(23, Number(h))).padStart(2, "0")}:${String(Math.min(59, Number(mi))).padStart(2, "0")}`;
    return { start: norm(m[1], m[2]), end: norm(m[3], m[4]) };
}

function inQuietHours(cfg: AdaptiveAccountConfig, at: Date): boolean {
    if (!cfg.quietStart || !cfg.quietEnd) return false;
    const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    if (cfg.quietStart <= cfg.quietEnd) return hm >= cfg.quietStart && hm < cfg.quietEnd;
    return hm >= cfg.quietStart || hm < cfg.quietEnd; // crosses midnight
}

// ───────────────────────── window ops ─────────────────────────

function evict(groupKey: string, cfg: AdaptiveAccountConfig) {
    const wf = loadWindow(groupKey);
    const now = nowMs();
    const minAgeMs = cfg.windowMinDays * 86400e3;
    const staleAgeMs = Math.max(minAgeMs * 5, 14 * 86400e3);
    while (wf.entries.length > 0) {
        const oldest = wf.entries[0];
        const age = now - oldest.ts;
        const overCount = wf.entries.length > cfg.windowMaxMessages;
        const overHard = wf.entries.length > cfg.windowHardCap;
        const tooOld = age > staleAgeMs;
        // 数量超限但仍在 minDays 保护期内 → 不淘汰(除非硬顶/过期)
        if ((overCount && age > minAgeMs) || overHard || tooOld) wf.entries.shift();
        else break;
    }
}

export type RecordParams = {
    accountId: string;
    groupId: string;
    messageId: string;
    ts: number;              // ms
    userId: string;
    nickname: string;
    text: string;
    isAdmin: boolean;
    replyToMessageId?: string;
    imageHints?: string[];
    cacheImages?: () => Promise<Array<{ url: string; path?: string; type?: string }>>;
};

/** 记录一条群消息到窗口(所有白名单群消息都记,含未触发判定的)。同步返回条目;图片缓存异步补齐。 */
export function recordGroupMessage(p: RecordParams): AdaptiveWindowEntry | null {
    const cfg = cfgFor(p.accountId);
    if (!cfg?.enabled || !cfg.groups.has(p.groupId)) return null;
    if (cfg.recordScope === "admins" && !p.isAdmin && String(p.userId) !== cfg.selfId) return null;
    const key = gkey(p.accountId, p.groupId);
    const wf = loadWindow(key);
    // 回复链: 找到被回复消息在窗口中的 seq
    let replyToSeq: number | undefined;
    if (p.replyToMessageId) {
        const target = wf.entries.find((e) => e.messageId === String(p.replyToMessageId));
        if (target) replyToSeq = target.seq;
    }
    const entry: AdaptiveWindowEntry = {
        seq: wf.nextSeq++,
        messageId: String(p.messageId),
        ts: p.ts,
        userId: String(p.userId),
        nickname: p.nickname || String(p.userId),
        text: String(p.text ?? "").slice(0, ENTRY_TEXT_CAP),
        ...(replyToSeq ? { replyToSeq } : {}),
        imageCount: p.imageHints?.length ?? 0,
        self: String(p.userId) === cfg.selfId,
    };
    wf.entries.push(entry);
    evict(key, cfg);
    persistWindow(key);
    if (p.imageHints?.length && p.cacheImages) {
        const cache = p.cacheImages;
        void (async () => {
            try {
                const entries = await cache();
                entry.media = entries
                    .filter((e) => e.path)
                    .map((e) => ({ path: e.path as string, type: e.type || "image/png" }))
                    .slice(0, 5);
                persistWindow(key);
            } catch (e: any) {
                traceLog(p.accountId, `image cache failed msg=${entry.messageId}: ${String(e?.message ?? e)}`);
            }
        })();
    }
    return entry;
}

/** Cody 自己的群发言镜像入窗(judge 需要知道她已经说过什么,防重复插嘴)。 */
export function recordSelfMessage(accountId: string, groupId: string, text: string) {
    const cfg = cfgFor(accountId);
    if (!cfg?.enabled || !cfg.groups.has(String(groupId))) return;
    const clean = String(text ?? "").replace(/\[CQ:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return;
    recordGroupMessage({
        accountId, groupId: String(groupId),
        messageId: `self-${nowMs()}`,
        ts: nowMs(),
        userId: cfg.selfId || "self",
        nickname: "我(Cody)",
        text: clean.slice(0, 800),
        isAdmin: true,
    });
}

export function onRecall(accountId: string, groupId: string, messageId: string) {
    if (!isAdaptiveGroup(accountId, groupId)) return;
    const key = gkey(accountId, String(groupId));
    const wf = loadWindow(key);
    const before = wf.entries.length;
    wf.entries = wf.entries.filter((e) => e.messageId !== String(messageId));
    if (wf.entries.length !== before) {
        persistWindow(key);
        alog(`recall removed window entry group=${groupId} msg=${messageId}`);
    }
}

/** 正常路径(@/关键词/命令)dispatch:窗口全部标记 injected 并取消待判定。 */
export function onNormalDispatch(accountId: string, groupId: string) {
    if (!isAdaptiveGroup(accountId, groupId)) return;
    const key = gkey(accountId, String(groupId));
    const wf = loadWindow(key);
    let changed = false;
    for (const e of wf.entries) if (!e.injected) { e.injected = true; changed = true; }
    if (changed) persistWindow(key);
    const st = getState(key);
    if (st.phase === "debounce") {
        if (st.debounceTimer) clearTimeout(st.debounceTimer);
        st.debounceTimer = null; st.pendingTriggerSeq = null; st.phase = "idle";
        traceLog(accountId, `group=${groupId} pending eval cancelled (normal dispatch took over)`);
    }
    // judging 阶段不打断:评估完成后注入组装会因全部 injected 而自动跳过
}

// ───────────────────────── trigger / FSM ─────────────────────────

function qualifiesAsTrigger(cfg: AdaptiveAccountConfig, entry: AdaptiveWindowEntry): boolean {
    if (entry.self) return false;
    if (cfg.adminsOnly && !cfg.admins.includes(entry.userId)) return false;
    // adminOnlyChat 群里,非 admin 触发的合成注入会被正常路径的管理闸门拦掉
    // (还可能触发"仅管理员"提示刷屏),不如根本不判。
    if (cfg.adminOnlyChat && !cfg.admins.includes(entry.userId)) return false;
    return true;
}

/** 消息被正常路径丢弃(无 @/关键词)后调用:按闸门决定是否排一次判定。 */
export function considerTrigger(accountId: string, groupId: string, entry: AdaptiveWindowEntry | null) {
    if (!entry) return;
    const cfg = cfgFor(accountId);
    if (!cfg?.enabled || !cfg.groups.has(String(groupId))) return;
    const key = gkey(accountId, String(groupId));
    const st = getState(key);
    if (!qualifiesAsTrigger(cfg, entry)) return;
    if (inQuietHours(cfg, new Date())) {
        traceLog(accountId, `group=${groupId} seq=${entry.seq} skipped: quiet hours`);
        return;
    }
    if (st.phase === "replying") {
        // 看门狗:合成回合可能因 steer 合并/异常而没走到 finally 钩子,超时自愈
        if (st.replyingSince && nowMs() - st.replyingSince > REPLYING_WATCHDOG_MS) {
            alog(`group=${groupId} REPLYING watchdog fired (stuck >${Math.round(REPLYING_WATCHDOG_MS / 60000)}min); resetting to idle`);
            st.phase = "idle";
            st.replyingSince = 0;
            // 落到下面的 idle 分支继续正常判定
        } else {
            st.queuedDuringReply.push(entry.seq);
            traceLog(accountId, `group=${groupId} seq=${entry.seq} queued during reply`);
            return;
        }
    }
    if (st.phase === "judging") return; // 判定中:窗口已记录,判定结果自然覆盖
    if (st.phase === "debounce") { st.pendingTriggerSeq = entry.seq; return; }
    // idle
    const now = nowMs();
    if (now - st.lastEvalAt < cfg.cooldownMs) {
        traceLog(accountId, `group=${groupId} seq=${entry.seq} skipped: cooldown ${Math.round((cfg.cooldownMs - (now - st.lastEvalAt)) / 1000)}s left`);
        return;
    }
    const hour = Math.floor(now / 3600e3);
    if (st.hourStamp !== hour) { st.hourStamp = hour; st.evalsThisHour = 0; }
    if (st.evalsThisHour >= cfg.maxPerHour) {
        traceLog(accountId, `group=${groupId} seq=${entry.seq} skipped: hourly cap ${cfg.maxPerHour}`);
        return;
    }
    st.phase = "debounce";
    st.pendingTriggerSeq = entry.seq;
    st.debounceTimer = setTimeout(() => {
        st.debounceTimer = null;
        const triggerSeq = st.pendingTriggerSeq;
        st.pendingTriggerSeq = null;
        if (triggerSeq == null) { st.phase = "idle"; return; }
        void evaluate(accountId, String(groupId), triggerSeq);
    }, cfg.debounceMs);
    traceLog(accountId, `group=${groupId} seq=${entry.seq} eval scheduled in ${cfg.debounceMs}ms`);
}

/** 回合完成钩子(executeDispatch finally):REPLYING → idle;有排队则按冷却再判一次。 */
export function onTurnComplete(accountId: string, groupId: string, info: { delivered: boolean; synthetic: boolean }) {
    if (!isAdaptiveGroup(accountId, groupId)) return;
    const key = gkey(accountId, String(groupId));
    const st = getState(key);
    if (st.phase !== "replying") return;
    st.phase = "idle";
    st.replyingSince = 0;
    const now = nowMs();
    if (info.delivered) st.lastReplyAt = now;
    const queued = st.queuedDuringReply.splice(0);
    if (queued.length === 0) {
        alog(`group=${groupId} adaptive turn done delivered=${info.delivered} synthetic=${info.synthetic} queue=empty`);
        return;
    }
    const cfg = cfgFor(accountId)!;
    const delay = Math.max(
        0,
        st.lastEvalAt + cfg.cooldownMs - now,
        info.delivered ? st.lastReplyAt + cfg.replyCooldownMs - now : 0,
    );
    const triggerSeq = queued[queued.length - 1];
    alog(`group=${groupId} adaptive turn done delivered=${info.delivered}; re-eval for ${queued.length} queued msg(s) in ${Math.round(delay / 1000)}s`);
    st.phase = "debounce";
    st.pendingTriggerSeq = triggerSeq;
    st.debounceTimer = setTimeout(() => {
        st.debounceTimer = null;
        const tsq = st.pendingTriggerSeq;
        st.pendingTriggerSeq = null;
        if (tsq == null) { st.phase = "idle"; return; }
        void evaluate(accountId, String(groupId), tsq);
    }, delay);
}

// ───────────────────────── persona & judge ─────────────────────────

function workspaceDir(): string {
    return process.env.OPENCLAW_WORKSPACE_DIR
        || path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw"), "workspace");
}

function loadPersona(): string {
    const files = ["SOUL.md", "IDENTITY.md", "USER.md"];
    const mtimes: Record<string, number> = {};
    let fresh = personaCache !== null;
    const content: Record<string, string> = {};
    for (const f of files) {
        const p = path.join(workspaceDir(), f);
        let mt = 0;
        try { mt = fs.statSync(p).mtimeMs; } catch { mt = 0; }
        mtimes[f] = mt;
        if (fresh && personaCache!.mtimes[f] !== mt) fresh = false;
        if (fresh) content[f] = personaCache!.files[f];
        else {
            try { content[f] = fs.readFileSync(p, "utf8").slice(0, 48 * 1024); } catch { content[f] = ""; }
        }
    }
    if (!fresh) personaCache = { files: content, mtimes, loadedAt: nowMs() };
    return [
        content["SOUL.md"] ? `<SOUL.md>\n${content["SOUL.md"]}\n</SOUL.md>` : "",
        content["IDENTITY.md"] ? `<IDENTITY.md>\n${content["IDENTITY.md"]}\n</IDENTITY.md>` : "",
        content["USER.md"] ? `<USER.md>\n${content["USER.md"]}\n</USER.md>` : "",
    ].filter(Boolean).join("\n\n");
}

function readOpenClawConfigFile(): { file: string; data: any } | null {
    const candidates = [
        process.env.OPENCLAW_CONFIG,
        process.env.OPENCLAW_CONFIG_PATH,
        path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "", ".openclaw"), "openclaw.json"),
        path.join(process.env.HOME || "", ".openclaw", "openclaw.json"),
    ].filter(Boolean) as string[];
    for (const file of candidates) {
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            return { file, data };
        } catch { /* try next */ }
    }
    return null;
}

type JudgeEndpoint = { url: string; apiKey: string; model: string };

function resolveJudgeEndpoint(judgeModel: string): JudgeEndpoint | null {
    const slash = judgeModel.indexOf("/");
    if (slash < 1) return null;
    const providerKey = judgeModel.slice(0, slash);
    const model = judgeModel.slice(slash + 1);
    const found = readOpenClawConfigFile();
    if (!found) return null;
    const provider = found.data?.models?.providers?.[providerKey];
    const baseUrl = String(provider?.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl) return null;
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    return { url, apiKey: String(provider?.apiKey ?? ""), model };
}

type ChatMessage = { role: string; content: string };

async function chatOnce(ep: JudgeEndpoint, messages: ChatMessage[], timeoutMs: number, opts?: { jsonMode?: boolean }): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const body: Record<string, any> = {
        model: ep.model,
        messages,
        temperature: 0.2,
        max_tokens: 700,
        stream: false,
    };
    if (opts?.jsonMode !== false) body.response_format = { type: "json_object" };
    try {
        const resp = await fetch(ep.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            // json_mode 不被支持 → 去掉重试一次
            if (resp.status === 400 && opts?.jsonMode !== false && /response_format|json_mode|json object/i.test(text)) {
                return await chatOnce(ep, messages, timeoutMs, { jsonMode: false });
            }
            throw new Error(`judge HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        const parsed = JSON.parse(text);
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("judge returned empty content");
        return content;
    } finally {
        clearTimeout(timer);
    }
}

function extractJson(raw: string): any {
    let text = raw.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    return JSON.parse(text);
}

async function judgeWithRetries(ep: JudgeEndpoint, messages: ChatMessage[], cfg: AdaptiveAccountConfig): Promise<any> {
    let convo = [...messages];
    let lastErr = "";
    for (let attempt = 0; attempt <= cfg.judgeMaxRetries; attempt++) {
        let out: string;
        try {
            out = await chatOnce(ep, convo, cfg.judgeTimeoutMs);
        } catch (e: any) {
            // 网络/HTTP 错误:不重试(冷却兜底),直接抛出
            throw new Error(`judge call failed: ${String(e?.message ?? e)}`);
        }
        try {
            const parsed = extractJson(out);
            if (typeof parsed?.reply !== "boolean") throw new Error("field `reply` must be boolean");
            if (parsed.messageIds !== undefined && !Array.isArray(parsed.messageIds)) throw new Error("field `messageIds` must be an array of numbers");
            return parsed;
        } catch (e: any) {
            lastErr = String(e?.message ?? e);
            if (attempt >= cfg.judgeMaxRetries) break;
            convo = [...convo, { role: "assistant", content: out.slice(0, 2000) }, {
                role: "user",
                content: `你的输出解析失败: ${lastErr}。请严格重新输出合法 JSON: {"reply":true|false,"reason":"...","messageIds":[...]}，不要输出任何其他文本。`,
            }];
        }
    }
    throw new Error(`judge output unparseable after ${cfg.judgeMaxRetries + 1} attempts: ${lastErr}`);
}

// ───────────────────────── evaluate ─────────────────────────

function fmtWindowLine(e: AdaptiveWindowEntry, cfg: AdaptiveAccountConfig): string {
    const d = new Date(e.ts);
    const hh = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const who = e.self ? "我(Cody)" : `${e.nickname}(${e.userId})`;
    const reply = e.replyToSeq ? ` (回复#${e.replyToSeq})` : "";
    const img = e.imageCount ? ` [图片×${e.imageCount}]` : "";
    const text = e.text.replace(/\s+/g, " ").slice(0, JUDGE_LINE_CAP);
    return `#${e.seq} [${hh}] ${who}${reply}: ${text}${img}`;
}

async function evaluate(accountId: string, groupId: string, triggerSeq: number) {
    const cfg = cfgFor(accountId);
    if (!cfg) return;
    const key = gkey(accountId, groupId);
    const st = getState(key);
    st.phase = "judging";
    const wf = loadWindow(key);
    const trigger = wf.entries.find((e) => e.seq === triggerSeq) ?? wf.entries[wf.entries.length - 1];
    if (!trigger) { st.phase = "idle"; return; }
    if (judgeInFlight >= 1) {
        // 全局并发 1:排队等其他群判完(15s 后直接重入,不吃冷却)
        traceLog(accountId, `group=${groupId} judge busy, retry in 15s`);
        st.phase = "idle";
        setTimeout(() => { void evaluate(accountId, groupId, triggerSeq); }, 15000);
        return;
    }
    st.evalsThisHour += 1;
    st.lastEvalAt = nowMs();

    let verdict: any = null;
    judgeInFlight++;
    const startedAt = nowMs();
    try {
        const ep = resolveJudgeEndpoint(cfg.judgeModel);
        if (!ep) throw new Error(`cannot resolve judge endpoint for "${cfg.judgeModel}" (check models.providers in openclaw.json)`);
        const criteria = cfg.criteria || readBootstrappedCriteria() || "(判据尚未生成:按人格常识判断,宁可不回复)";
        const lines = wf.entries.map((e) => fmtWindowLine(e, cfg)).join("\n");
        const sys = [
            "你是 QQ 群聊参与度判定器。根据下面的人格文件、参与判据和群聊近期上下文,判断最新的触发消息是否值得你(Cody)主动插嘴回复。",
            "",
            "【人格文件】",
            loadPersona(),
            "",
            "【参与判据(你自己在引导时列出的、想要回复/插嘴的情形)】",
            criteria,
            "",
            "【硬性规则】",
            '- 只输出一个 JSON 对象: {"reply":true或false,"reason":"一句话理由","messageIds":[注入上下文用的消息序号]}',
            `- messageIds 必须包含触发消息序号 #${trigger.seq},可另外挑选与本次话题直接相关的少量消息`,
            "- 标注 (我(Cody)) 的行是你自己说过的话:内容已被回应过就不要再接,防止复读",
            "- 其他机器人/系统消息不作为回复对象",
            "- 群聊是公共场合:涉及隐私、亲密、NSFW 的话题一律 reply=false(参考人格文件里的公共模式守则)",
            "- 拿不准就 reply=false;冷却后还有机会",
        ].join("\n");
        const usr = `【群 ${groupId} 近期上下文(共${wf.entries.length}条,时间为本地时间)】\n${lines}\n\n【触发消息】#${trigger.seq}\n请输出 JSON 判定。`;
        verdict = await judgeWithRetries(ep, [
            { role: "system", content: sys },
            { role: "user", content: usr },
        ], cfg);
    } catch (e: any) {
        st.phase = "idle";
        alog(`group=${groupId} trigger=#${triggerSeq} judge FAILED (${nowMs() - startedAt}ms): ${String(e?.message ?? e).slice(0, 200)}`);
        return;
    } finally {
        judgeInFlight--;
    }

    const reply = verdict.reply === true;
    const reason = String(verdict.reason ?? "").slice(0, 200);
    const requested: number[] = Array.isArray(verdict.messageIds)
        ? verdict.messageIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
        : [];
    alog(`group=${groupId} trigger=#${triggerSeq} verdict=${reply ? "REPLY" : "skip"} reason="${reason}" requested=[${requested.join(",")}] (${nowMs() - startedAt}ms)${cfg.dryRun ? " [dryRun]" : ""}`);

    if (!reply) { st.phase = "idle"; return; }

    // 选择注入集合:judge 选中 ∩ 未注入;为空则兜底(触发消息+最近未注入)
    const bySeq = new Map(wf.entries.map((e) => [e.seq, e]));
    let selected = requested.map((s) => bySeq.get(s)).filter((e): e is AdaptiveWindowEntry => Boolean(e && !e!.injected));
    if (selected.length === 0) {
        if (trigger.injected) { st.phase = "idle"; alog(`group=${groupId} all selected context already injected; skip`); return; }
        const recent = wf.entries.filter((e) => !e.injected && !e.self).slice(-5);
        selected = recent.some((e) => e.seq === trigger.seq) ? recent : [...recent, trigger];
    }
    if (!selected.some((e) => e.seq === trigger.seq) && !trigger.injected) selected.push(trigger);
    selected.sort((a, b) => a.seq - b.seq);

    if (cfg.dryRun) {
        st.phase = "idle";
        alog(`group=${groupId} dryRun: would inject ${selected.length} msg(s): [${selected.map((e) => e.seq).join(",")}]`);
        return;
    }

    // 标记 injected(先标记再注入,防并发重复)
    for (const e of selected) e.injected = true;
    persistWindow(key);

    const invoker = invokers.get(accountId);
    if (!invoker) { st.phase = "idle"; alog(`group=${groupId} no invoker attached; abort injection`); return; }

    // 组装上下文块 + 媒体
    const d0 = new Date();
    const ctxLines = selected.map((e) => {
        const d = new Date(e.ts);
        const hh = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
        const who = e.self ? "我自己" : `${e.nickname}(QQ:${e.userId})`;
        const reply = e.replyToSeq ? ` (回复 #${e.replyToSeq})` : "";
        const img = e.imageCount && !(e.media?.length) ? ` [图片×${e.imageCount}(未缓存)]` : "";
        return `#${e.seq} [${hh}] ${who}${reply}: ${e.text}${img}`;
    }).join("\n");
    const mediaEntries: AdaptiveOverride["mediaEntries"] = [];
    for (const e of selected) {
        for (const m of e.media ?? []) {
            if (mediaEntries.length < 5) mediaEntries.push({ url: "", path: m.path, type: m.type });
        }
    }
    const contextBlock = [
        "<adaptive_context>",
        "[主动插嘴触发] 你(判定器)根据人格与判据决定参与这个群聊。以下是选中注入的消息上下文(本地时间,含发送人QQ号):",
        `判定理由: ${reason || "(未提供)"}`,
        ctxLines,
        mediaEntries.length ? `(附带 ${mediaEntries.length} 张选中消息的图片,已作为媒体附加)` : "",
        "要求: 以群聊分寸回应(公共场合守则);看完上下文若觉得其实不需要回复,直接以 NO_REPLY 结束,不要硬凑。",
        "</adaptive_context>",
        "",
    ].filter(Boolean).join("\n");

    const syntheticId = `adaptive-${nowMs()}-${Math.floor(Math.random() * 1e4)}`;
    const markerText = `【主动插嘴】(adaptive trigger #${trigger.seq} @ ${d0.toLocaleTimeString("zh-CN", { hour12: false })})`;
    const event: OneBotEvent = {
        time: Math.floor(nowMs() / 1000),
        self_id: Number(cfg.selfId) || 0,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: Number(syntheticId.replace(/\D/g, "")) || nowMs(),
        user_id: Number(trigger.userId) || 0,
        group_id: Number(groupId) || 0,
        sender: { user_id: Number(trigger.userId) || 0, nickname: trigger.nickname },
        message: [{ type: "text", data: { text: markerText } }],
        raw_message: markerText,
    } as OneBotEvent;
    const syntheticKey = String(event.message_id);
    syntheticOverrides.set(syntheticKey, { contextBlock, mediaEntries, syntheticId });
    markSynthetic(syntheticKey);

    st.phase = "replying";
    st.replyingSince = nowMs();
    alog(`group=${groupId} INJECT seqs=[${selected.map((e) => e.seq).join(",")}] media=${mediaEntries.length} syntheticId=${syntheticId} triggerUser=${trigger.userId}`);
    try {
        await invoker(event, { contextBlock, mediaEntries, syntheticId });
    } catch (e: any) {
        st.phase = "idle";
        syntheticOverrides.delete(syntheticKey);
        unmarkSynthetic(syntheticKey);
        alog(`group=${groupId} synthetic dispatch failed: ${String(e?.message ?? e)}`);
    }
}

// ───────────────────────── synthetic event registry ─────────────────────────

const syntheticIds = new Set<string>();

export function markSynthetic(id: string) { syntheticIds.add(id); }
export function unmarkSynthetic(id: string) { syntheticIds.delete(id); }
export function isSynthetic(messageId: string | number | undefined): boolean {
    return messageId !== undefined && syntheticIds.has(String(messageId));
}
export function takeOverride(messageId: string | number | undefined): AdaptiveOverride | null {
    if (messageId === undefined) return null;
    return syntheticOverrides.get(String(messageId)) ?? null;
}
export function releaseOverride(messageId: string | number | undefined) {
    if (messageId === undefined) return;
    syntheticOverrides.delete(String(messageId));
    unmarkSynthetic(String(messageId));
}

// ───────────────────────── criteria bootstrap ─────────────────────────

function readBootstrappedCriteria(): string {
    const meta = readMeta();
    return typeof meta.criteriaText === "string" ? meta.criteriaText : "";
}

function writeCriteriaToConfigFile(criteria: string): boolean {
    const found = readOpenClawConfigFile();
    if (!found) return false;
    try {
        found.data.channels ??= {};
        found.data.channels.qq ??= {};
        found.data.channels.qq.adaptiveReplyCriteria = criteria;
        const backup = `${found.file}.bak-adaptive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(found.file, backup);
        const tmp = found.file + ".tmp-adaptive";
        fs.writeFileSync(tmp, JSON.stringify(found.data, null, 2));
        fs.renameSync(tmp, found.file);
        return true;
    } catch (e: any) {
        alog(`criteria config write failed: ${String(e?.message ?? e)}`);
        return false;
    }
}

/** 首次启用且判据为空:一次性直连调用让模型(带人格)自己列出想插嘴的情形,写入配置。 */
export async function bootstrapCriteriaIfNeeded(accountId: string) {
    const cfg = cfgFor(accountId);
    if (!cfg?.enabled) return;
    if (cfg.criteria) return;                       // 配置显式给了判据
    if (readBootstrappedCriteria()) return;          // 已有引导存档
    const meta = readMeta();
    if (meta.criteriaBootstrapDone && meta.criteriaBootstrapSkippedWrite) return;
    if (bootstrapInFlight) return;
    bootstrapInFlight = true;
    try {
        const ep = resolveJudgeEndpoint(cfg.judgeModel);
        if (!ep) { alog("criteria bootstrap skipped: judge endpoint unresolvable"); return; }
        const sys = [
            "你是 Cody。以下是你的人格文件和联系人列表。",
            loadPersona(),
            "",
            "任务: 为 QQ 群聊'主动插嘴'功能生成你的参与判据。列出你想要回复/插嘴的具体情形(以及明确不想插嘴的情形),用第一人称、可执行、10-20 条,尊重人格文件里的公共场合守则(隐私、分寸、不 NSFW)。",
            '只输出 JSON: {"criteria":["情形1","情形2",...],"notCriteria":["不插嘴的情形1",...]}',
        ].join("\n");
        const out = await chatOnce(ep, [
            { role: "system", content: sys },
            { role: "user", content: "请生成判据 JSON。" },
        ], Math.max(cfg.judgeTimeoutMs, 120000));
        const parsed = extractJson(out);
        const want = Array.isArray(parsed?.criteria) ? parsed.criteria.map((s: any) => String(s).trim()).filter(Boolean) : [];
        const not = Array.isArray(parsed?.notCriteria) ? parsed.notCriteria.map((s: any) => String(s).trim()).filter(Boolean) : [];
        if (want.length === 0) throw new Error("bootstrap produced no criteria");
        const text = [
            "【想插嘴的情形】",
            ...want.map((s) => `- ${s}`),
            ...(not.length ? ["【明确不插嘴】", ...not.map((s) => `- ${s}`)] : []),
            `(由 ${cfg.judgeModel} 于 ${new Date().toISOString()} 引导生成;可直接改 channels.qq.adaptiveReplyCriteria 覆盖)`,
        ].join("\n");
        const written = writeCriteriaToConfigFile(text);
        writeMeta({
            criteriaBootstrapDone: true,
            criteriaBootstrapAt: new Date().toISOString(),
            criteriaBootstrapModel: cfg.judgeModel,
            criteriaBootstrapSkippedWrite: !written,
            ...written ? {} : { criteriaText: text },
        });
        cfg.criteria = written ? "" : text; // 写进配置后走热更新;失败则用内存/存档兜底
        alog(`criteria bootstrapped via ${cfg.judgeModel}: ${want.length} want + ${not.length} not; configWritten=${written}`);
        if (written && cfg.notifyUser) {
            try {
                senders.get(accountId)?.sendPrivate(cfg.notifyUser,
                    `🧠 群聊自适应插嘴判据已自动生成并写入配置(channels.qq.adaptiveReplyCriteria):\n\n${text.slice(0, 1500)}\n\n不满意可直接改配置,或群里发 /adaptive relearn 重新生成。`);
            } catch { /* best effort */ }
        }
    } catch (e: any) {
        const meta = readMeta();
        const attempts = Number(meta.criteriaBootstrapAttempts ?? 0) + 1;
        const giveUp = attempts >= 3;
        alog(`criteria bootstrap failed (attempt ${attempts}/3${giveUp ? ", giving up — use /adaptive relearn" : ""}): ${String(e?.message ?? e).slice(0, 300)}`);
        writeMeta({
            criteriaBootstrapAttempts: attempts,
            criteriaBootstrapLastError: String(e?.message ?? e).slice(0, 300),
            ...(giveUp ? { criteriaBootstrapDone: true, criteriaBootstrapSkippedWrite: true } : {}),
        });
    } finally {
        bootstrapInFlight = false;
    }
}

export async function relearnCriteria(accountId: string) {
    writeMeta({ criteriaBootstrapDone: false, criteriaBootstrapSkippedWrite: false, criteriaText: "" });
    const cfg = cfgFor(accountId);
    if (cfg) cfg.criteria = "";
    await bootstrapCriteriaIfNeeded(accountId);
}

// ───────────────────────── status (for /adaptive) ─────────────────────────

export function adaptiveStatus(accountId: string, groupId?: string): string {
    const cfg = cfgFor(accountId);
    if (!cfg) return "adaptive: 未配置";
    const lines: string[] = [
        `🧠 adaptive: ${cfg.enabled ? "ON" : "OFF"} groups=[${[...cfg.groups].join(",") || "-"}] dryRun=${cfg.dryRun}`,
        `judge=${cfg.judgeModel} cooldown=${Math.round(cfg.cooldownMs / 1000)}s replyCooldown=${Math.round(cfg.replyCooldownMs / 1000)}s quiet=${cfg.quietStart ?? "-"}~${cfg.quietEnd ?? "-"} adminsOnly=${cfg.adminsOnly} record=${cfg.recordScope}`,
        `criteria: ${cfg.criteria ? `${cfg.criteria.length} chars (config)` : readBootstrappedCriteria() ? `${readBootstrappedCriteria().length} chars (bootstrap)` : "(未生成)"}`,
    ];
    const keys = groupId ? [gkey(accountId, String(groupId))] : [...windows.keys()].filter((k) => k.startsWith(accountId + ":")).slice(0, 8);
    for (const k of keys) {
        const wf = windows.get(k) ?? loadWindow(k);
        const st = states.get(k);
        const injected = wf.entries.filter((e) => e.injected).length;
        lines.push(`· ${k.split(":").slice(1).join(":")}: ${wf.entries.length} 条(已注入 ${injected}) phase=${st?.phase ?? "idle"} lastEval=${st?.lastEvalAt ? new Date(st.lastEvalAt).toLocaleTimeString("zh-CN", { hour12: false }) : "-"} queued=${st?.queuedDuringReply.length ?? 0}`);
    }
    return lines.join("\n");
}

export function currentCriteria(accountId: string): string {
    const cfg = cfgFor(accountId);
    if (cfg?.criteria) return cfg.criteria;
    return readBootstrappedCriteria();
}

export function setCriteriaConfig(accountId: string, text: string): boolean {
    const ok = writeCriteriaToConfigFile(text);
    if (ok) {
        const cfg = cfgFor(accountId);
        if (cfg) cfg.criteria = text;
    }
    return ok;
}

/** startAccount 时加载所有已持久化窗口(重启不丢)。 */
export function loadPersistedWindows() {
    try {
        ensureStateDir();
        let loaded = 0;
        for (const f of fs.readdirSync(STATE_DIR)) {
            if (!/^window_.+\.json$/.test(f)) continue;
            try {
                const wf = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), "utf8"));
                const key = typeof wf?.groupKey === "string" ? wf.groupKey : null;
                if (!key || windows.has(key)) continue;
                windows.set(key, { nextSeq: Number(wf.nextSeq) || (wf.entries?.length ?? 0) + 1, entries: Array.isArray(wf.entries) ? wf.entries : [] });
                loaded++;
            } catch { /* skip corrupt file */ }
        }
        if (loaded > 0) alog(`loaded ${loaded} persisted adaptive window(s) from ${STATE_DIR}`);
    } catch { /* no state yet */ }
}
