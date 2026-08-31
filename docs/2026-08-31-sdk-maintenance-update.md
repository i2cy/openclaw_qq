# 2026-08-31 内核 API 迁移与维护更新

> 这轮更新面向 OpenClaw 2026.6.x 的运行时：把插件源码里已弃用（deprecated）的通道运行时接口全部迁移到官方 SDK 路径，同时修复了"新消息打断旧回复"只停投递、不真取消的问题，并补齐了 WebUI 配置表单。

## 这轮改了什么

### 1. 入站上下文改用官方 facts 式构造

- `runtime.channel.reply.finalizeInboundContext(...)`（deprecated）→ `buildChannelInboundEventContext(...)`（来自 `openclaw/plugin-sdk/channel-inbound`）。
- 字段逐一映射到新契约：`sender` / `conversation` / `route` / `reply` / `message` / `access`，媒体载荷与 `ReplyToBody` / `ReplyToSender` / `ThreadLabel` 等附加字段通过 `extra` 透传。
- 产出字段（`Body` / `RawBody` / `BodyForAgent` / `SessionKey` / `SenderId` / `SenderName` / `MediaPaths` 等）与旧实现保持一致，会话记录内容不改变。

### 2. 会话记录迁移到内核路径

- 手动调用 `recordInboundSession` + `resolveStorePath`（均 deprecated）→ 在 `drainSessionQueue` 里改用 `runPreparedInboundReply`（`PreparedChannelTurn` 包装）。
- 内核负责 record → dispatch → finalize 全流程；插件的重试 / Fast Fail / 模型回退等自定义分发逻辑保留在 `runDispatch` 中不变。
- `/newsession` 与 `/end` 的会话路径解析改用 `resolveInboundSessionEnvelopeContext(...).storePath`。
- 净效果：插件源码不再直接调用任何 deprecated 的通道运行时接口，运行行为等价。

### 3. interruptOnNewMessage 升级为"真中断"

- 之前：新消息到达后只停止**投递**旧回复，在途的模型请求仍会跑完（慢模型下表现为"打断无效"）。
- 现在：每次分发创建 `AbortController`，`isStale()` 变为 `true` 时立即 `abort()`，并通过 `replyOptions.abortSignal` 传入 dispatcher —— 在途模型请求被真正取消，新请求立刻接手。

### 3.5 interruptOnNewMessage 新增 steer 模式（opencode 风格）

- 取值升级为三态：`"off"`（默认）/ `"abort"` / `"steer"`（旧布尔值 `true`/`false` 分别等价 `"abort"`/`"off"`，升级时请迁移配置）。
- `"steer"` 模式下，处理中新到达的消息会通过 `enqueueNextTurnInjection`（会话持久化的 next-turn 注入）排队：不中断当前 run，当前这一轮工具调用完成后，注入队列中的全部消息会被模型在下一轮 prompt 构建时吸收，带着新指令继续同一任务 —— 与 opencode 的 steer 行为一致。
- 多条 steer 消息会自然合并（prompt 构建时一次性 drain 该会话的全部待注入项）。
- 若注入通道不可用（会话未就绪等），自动回退到常规队列，消息不会丢。

### 4. WebUI 配置表单修复

- 旧版 manifest 缺少 `channelConfigs.qq`，dashboard 拿不到通道配置 schema，显示 "Unsupported type: . Use Raw mode" 的占位控件，无法可视化调节。
- manifest 现已补齐 `channelConfigs.qq`：由 `QQConfigSchema` 生成完整 JSON Schema（56 个配置项，均带类型与中文描述），并附带插件自带的 13 项中文 uiHints 标签。
- `additionalProperties: true` 保持与 zod `passthrough()` 相同的宽松校验语义，不会误伤现有配置。

### 5. 合并消息携带身份与时间

- `queueDebounceMs > 0` 触发连续消息合并时，每条消息由无身份信息的 `[消息 N]:` 改为 `[HH:MM:SS 昵称(QQ号)]:` 前缀，来源与时间一目了然。

### 6. 系统上下文与用户消息分离（不再泄漏、不再双倍 token）

- 之前 `<context_layers>` / `<history>` / `<attachments>` 等系统上下文块被拼进 `Body`，会出现在 session 记录与 WebUI dashboard 的消息视图里。
- 现在 `Body` 只保留用户原文（`cleanCQCodes(text)` + 回复引用后缀），全部系统上下文块只进 `BodyForAgent`（模型输入），肉眼可见的消息面不再出现任何标签。
- `enrichReplyForwardContext` 默认改为 `false`：未显式开启时完全不注入 `<context_layers>` 块。
- `includeCurrentOutline` 默认改为 `false`：不再把当前消息概要回显进上下文（当前消息本身就是模型输入，回显等于双倍 token）。
- 需要引用 / 合并转发线索时，显式开启 `enrichReplyForwardContext=true` 即可。

## 影响范围

- 无需改动任何配置项即可升级；`interruptOnNewMessage` 语义增强无需额外配置。
- 默认行为变化：`enrichReplyForwardContext` 与 `includeCurrentOutline` 默认关闭，回复 / 转发上下文注入改为按需开启。
- 建议升级后重启网关，并用一条真实 QQ 消息验证回复正常。
