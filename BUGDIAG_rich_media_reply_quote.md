# Bug 诊断：媒体/富文本输出被强制引用（CQ:reply）且正文为空

- **日期：** 2026-09-02
- **插件位置：** `~/.openclaw/extensions/qq`（QQ OneBot channel plugin）
- **症状报告人：** dad（群聊 + 私聊复现）
- **状态：** 已定位根因，**未改代码**。预留给独立 agent 修复（医者不能自医）。

---

## 1. 症状

当本 bot 的**输出只有富文本 / 只有媒体**（例如：
- `[[tts:text]]...[[/tts:text]]` 语音消息；
- `MEDIA:<path>` 而没有任何可见文本；
- 只有音频 / 语音 / 图片 / 富文本块，`payload.text` 为空）

QQ 端会把这个消息渲染成**一条引用消息**（`[CQ:reply]`），引用对象是触发它的那条人的消息（看起来像「我在回复某人」），并且**正文区域是空的**（只有引用框，看不到任何内容）。

> dad 的原始描述：*「if you are outputting only a rich text it would happened (replying to my message and nothing is showing in)」* / *「when you use MEDIA: only without any other text that bug would appear too」*

**关键：** 这不是配置开关问题，而是**两条发送路径行为不一致**导致的。

---

## 2. 根因（核心）

### 2.1 发送路径拆条

插件里有两条出站路径，行为不同：

| 出站内容 | 走哪条 | 加不加 CQ:reply | 表现 |
|---|---|---|---|
| 普通流式纯文本 | `sendProcessedText()` → `client.sendGroupMsg()` | 不加 reply，改加 `[CQ:at,qq=...]` @ 发起人 | 独立消息，正常 |
| 媒体 / 富文本 / 语音（durable final delivery） | `deliver()` → `outbound.sendMedia/sendPayload` → `sendQQMediaMessage()` | **会加 `[CQ:reply]`** | 变成引用消息，且正文空 |

### 2.2 具体代码位置（`src/channel.ts`）

**A. 纯文本路径（独立、@ 发起人，无引用）——第 4182 行：**
```ts
if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
```

**B. 媒体路径加引用——`sendQQMediaMessage()`，第 2941 行：**
```ts
if (params.replyToId && !(params.text && params.text.trim()))
    mediaMessage.push({ type: "reply", data: { id: String(params.replyToId) } });
```
也就是说：**只要 `replyToId` 存在、且没有文本，就强制塞一个 `reply` segment**。媒体/语音/富文本没有 text → 命中此分支 → 变成引用消息。

**C. `sendQQTextMessage()`，第 2865 行（文本也带 reply 的情况）：**
```ts
if (params.replyToId && i === 0) {
    message = [{ type: "reply", data: { id: String(params.replyToId) } }, { type: "text", data: { text: chunks[i] } }];
}
```

**D. `deliver()` 把 replyToId 传给媒体 send——第 4351 行：**
```ts
replyToId: payload.replyToId || undefined,
```

### 2.3 `replyToId` 是从哪来的（SDK 侧，非插件发明）

`replyToId` 不是插件自己编的，而是 SDK 在 durable final delivery 时解析出来的。SDK：
`~/.openclaw/extensions/qq/node_modules/openclaw/dist/kernel-Cmg67z5F.js`

**`resolveDurableInboundReplyToId()`，第 337–339 行：**
```js
function resolveDurableInboundReplyToId(params) {
    if (params.replyToId === null || params.payload.replyToId === null) return null;
    return normalizeOptionalString(params.replyToId)
        ?? normalizeOptionalString(params.payload.replyToId)
        ?? normalizeOptionalString(params.ctxPayload.ReplyToIdFull)
        ?? normalizeOptionalString(params.ctxPayload.ReplyToId);
}
```
（在第 391 行被 `deliverInboundReplyWithMessageSendContext` 调用：`const replyToId = resolveDurableInboundReplyToId(params);`）

优先级：显式 `params.replyToId` > `payload.replyToId` > `ctxPayload.ReplyToIdFull` > `ctxPayload.ReplyToId`。

**其中 `ctxPayload.ReplyToId` / `ReplyToIdFull` 由插件打进 inbound 上下文**（`src/channel.ts`）：
- 第 3921 行：`const replyMsgId = getReplyMessageId(event.message, inboundRawMessage, event);`（拿到**本条入站消息自己引用**的消息 id）
- 第 4494 行：`...(replyMsgId && { replyToId: String(replyMsgId) }),`
- 第 4507 行：`...(replyMsgId && { ReplyToBody: replyToBody, ReplyToSender: replyToSender }),`

> 因此：**入站消息如果是「引用某消息」发出的，这个被引用的 id 会被原样传播到出站**，导致 bot 的媒体回复被引用到「人发消息时引用的那条」，而不是 bot 真正要回的那条 —— 看起来就像 bot 莫名其妙「回复」了一个无关的人。

---

## 3. 为什么「正文空」

媒体/语音/富文本 payload 的 `payload.text` 通常为空（比如裸语音、`asVoice`、无 caption 的 MEDIA）。`sendQQMediaMessage` 里：
- 因为 text 为空 → 不产生 textAck；
- 因为 `replyToId` 存在且 text 为空 → **第 2941 行直接塞一个 `reply` segment，没有任何 text 跟随**。

结果为：QQ 渲染一条**仅含 `[CQ:reply]` 引用、且没有任何正文**的消息 → 「只有引用框，nothing showing」。

---

## 4. 复现条件（判定标准）

1. 出站 payload 为 **rich / media / voice only**（无非空 `text`）。
2. 该 turn 是从带 reply 上下文的入站消息（或 durable delivery 路径）触发的 → SDK 解析出 `replyToId`。
3. 满足以上 → `sendQQMediaMessage` 走第 2941 行 → 产生空正文的引用消息。

**正常纯文本不受影响**（走 `sendProcessedText`，用 `[CQ:at]` 而不是 `[CQ:reply]`）。

---

## 5. 建议修复方向（供独立 agent 选择）

目标：**让媒体/富文本路径与纯文本路径保持一致**，媒体/语音尽量独立落位，不要无脑引用。

**方案 A（推荐，插件侧最小改动）：**
- 在 `sendQQMediaMessage()`（第 2941 行附近）**当 `text` 为空时不要新增 reply segment**；即只对「有文本 + 被显式要求引用」的情况添加引用。
- 或：media/voice 发送时**剥离/忽略自动传播来的 `replyToId`**，除非 `replyTo` 被**显式**传进来。

**方案 B（更彻底）：**
- 在 `deliver()` / `outbound.sendPayload` 处，对 `audioAsVoice` 或 `media-only` 的 payload 强制 `replyToId = undefined`，从而与 `sendProcessedText` 的独立行为对齐。

**方案 C（对齐语义）：**
- 引入配置项（如 `mediaAutoQuote: boolean`，默认 `false` 或不引用），让「是否引用」只由显式 `replyTo` 驱动，而不是由 inbound reply 上下文自动传播。

> 注意：不要改 SDK 的 `resolveDurableInboundReplyToId`（在 node_modules，重启会被覆盖）；优先在插件 `src/channel.ts` 里克制 reply 注入。

---

## 6. 需要遵守的约束

- 修改后需重新 build 插件（本插件有 `src/` TS 源），并重启 gateway / 加载插件生效。
- 保持与现有发送逻辑（`sendQQTextMessage` 的显式 reply、`[CQ:at]` 行为）不冲突。
- 纯文本路径（`sendProcessedText`）不要动，它是对的。
- 若走方案 A，注意 `sendQQTextMessage`（第 2865 行）在「有文本 + replyToId」时仍要保留引用能力（显式 replyTo 场景），只裁剪「无文本」的媒体分支。

---

*诊断完毕。以上供修复 agent 直接使用；修复后再按复现条件回归验证。*
