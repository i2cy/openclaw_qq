import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { qqChannel } from "./src/channel.js";
import { setQQRuntime, setQQApi, drainSteerTexts } from "./src/runtime.js";

const plugin = {
  id: "qq",
  name: "QQ (OneBot)",
  description: "QQ channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQRuntime(api.runtime);
    setQQApi(api);
    // steer: fires at EVERY prompt build (including mid-run tool rounds), so
    // queued steering messages land in the very next prompt the model sees.
    api.registerHook(
      "before_prompt_build",
      ((event: any, ctx: any) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return;
        const texts = drainSteerTexts(sessionKey);
        if (texts.length === 0) return;
        const injected =
          "[User sent a steering message while you were working. Treat it as the latest instruction from the user — acknowledge it and apply it as part of the current task]:\n" +
          texts.join("\n\n");
        console.log(`[QQ] steer injected sess=${sessionKey} count=${texts.length} text="${texts[0].slice(0, 60)}"`);
        return { prependContext: injected };
      }) as any,
      { name: "qq-steer" }
    );
    api.registerChannel({ plugin: qqChannel });
  },
};

export default plugin;
