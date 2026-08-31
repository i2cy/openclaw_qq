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
