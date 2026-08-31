import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
let pluginApi: OpenClawPluginApi | null = null;

export function setQQRuntime(next: PluginRuntime) {
    runtime = next;
}

export function getQQRuntime(): PluginRuntime {
    if (!runtime) {
        throw new Error("QQ runtime not initialized");
    }
    return runtime;
}

export function setQQApi(next: OpenClawPluginApi) {
    pluginApi = next;
}

export function getQQApi(): OpenClawPluginApi {
    if (!pluginApi) {
        throw new Error("QQ plugin api not initialized");
    }
    return pluginApi;
}

// ---- steer queue (opencode-style): pending per-session steering messages ----
// consumed by the before_prompt_build hook, which fires at EVERY prompt build
// (including mid-run tool rounds), so a queued steer lands in the very next
// prompt the model sees.
const steerQueue = new Map<string, string[]>();

export function pushSteerText(sessionKey: string, text: string) {
    const q = steerQueue.get(sessionKey) ?? [];
    q.push(text);
    steerQueue.set(sessionKey, q);
}

export function drainSteerTexts(sessionKey: string): string[] {
    const q = steerQueue.get(sessionKey);
    if (!q || q.length === 0) return [];
    steerQueue.delete(sessionKey);
    return q;
}
