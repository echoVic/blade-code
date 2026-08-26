---
name: knowledge-model-and-provider-runtime-provider-transport-and-context-adaptation
description: >
  覆盖 Blade Message/Tool 到 pi-ai Context 的转换、不同 wire API 的请求选项、图片与
  thinking 能力处理、语义流适配和 watchdog。Navigate when: 修改 Provider payload、
  required tool、reasoning/service tier/verbosity、图片历史、流事件或 EOF/idle timeout
  行为。Excludes: 模型与凭据目录（见 ../model-catalog-configuration-and-credentials/），
  重试、熔断、排队和缓存异常归因（见
  ../provider-resilience-admission-and-observability/）。Keywords: createPiContext,
  buildPiOptions, streamPiModel, messageHistory, toolChoice, StreamIdleTimeoutError,
  ProviderStreamClosedError.
---

## Module Structure

该节点是 Blade 内部聊天契约与 pi-ai Provider 协议之间的适配边界：先清理历史并构造
Context，再按模型 API 生成请求参数，最后把 pi-ai 语义事件投影成统一 `StreamChunk`。

### Directory Layout
- `packages/cli/src/services/ChatServiceInterface.ts` — 内部 Message、Tool、ChatConfig 与 StreamChunk 契约
- `packages/cli/src/services/PiAIChatService.ts` — 适配步骤的调用顺序和流式提交边界
- `packages/cli/src/services/pi/messageHistory.ts` — 工具调用历史完整性过滤
- `packages/cli/src/services/pi/contextAdapter.ts` — system/user/assistant/toolResult 与图片转换
- `packages/cli/src/services/pi/requestOptions.ts` — thinking、tool choice、tier、verbosity、缓存和响应元数据选项
- `packages/cli/src/services/pi/reasoningEffort.ts` — reasoning 能力协商
- `packages/cli/src/services/pi/serviceTier.ts` — service tier 能力协商
- `packages/cli/src/services/pi/responseVerbosity.ts` — verbosity 能力协商
- `packages/cli/src/services/pi/streamAdapter.ts` — pi-ai 事件映射和流活性 watchdog

### Key Entry Points
- `createPiContext()` in `packages/cli/src/services/pi/contextAdapter.ts` — 构造 Provider 上下文和工具声明
- `buildPiOptions()` in `packages/cli/src/services/pi/requestOptions.ts` — 生成 wire API 特定请求选项
- `streamPiModel()` in `packages/cli/src/services/pi/streamAdapter.ts` — 将 pi-ai iterator 转为 Blade 流
- `PiAIChatService.streamChat()` in `packages/cli/src/services/PiAIChatService.ts` — 在适配层外建立能力预检和重放边界

## Gotchas
- `PiAIChatService` 会在转换前扫描过滤后的全部用户历史，只要文本模型遇到任意图片就拒绝请求；`createPiContext()` 中“历史图片替换为占位文本”的降级只对直接调用适配器有效，不能据此假设完整聊天路径会降级 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/contextAdapter.ts`, `packages/cli/tests/unit/services/pi-ai-chat-service.test.ts`)
- 工具历史不是逐条容错：assistant 的 tool call 必须紧跟一组 ID 完整且唯一匹配的 tool result，否则 assistant 调用及其相邻 tool result 会整组移除，孤立 tool 消息也直接丢弃 (`packages/cli/src/services/pi/messageHistory.ts`)
- required tool 必须先存在于当前工具集合；适配器随后只向 Provider 暴露该工具并仍按名称排序，避免“强制不存在工具”或缓存前缀因注册顺序漂移 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/contextAdapter.ts`)
- required tool continuation 或历史中存在“有 tool call 但没有 reasoning”的 assistant 消息时，会关闭本次 thinking；否则部分 Provider 会因跨轮 reasoning/tool 协议不一致拒绝请求 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/messageHistory.ts`, `packages/cli/src/services/pi/requestOptions.ts`)
- 历史工具参数 JSON 无效、不是对象或是数组时不会阻断恢复，而是告警并降级为空对象；依赖原始参数字符串做重放会得到不同语义 (`packages/cli/src/services/pi/contextAdapter.ts`)
- Provider iterator 未发出 `done` 就自然结束会转成 `ProviderStreamClosedError`，而不是成功的空响应；零输出 EOF 可重试，主动 idle timeout 则禁止同 Provider 自动重试 (`packages/cli/src/services/pi/streamAdapter.ts`, `packages/cli/src/services/pi/providerRetry.ts`)
- stall warning 只是同一个 pending `iterator.next()` 上的观测事件，不会启动第二次读取，也不会越过重放边界；只有真实 text、reasoning、tool、usage 或 finish chunk 才提交该尝试 (`packages/cli/src/services/pi/streamAdapter.ts`, `packages/cli/src/services/PiAIChatService.ts`)
- 显式 response verbosity 会先做模型能力校验，不支持的 fallback 会在构造请求参数时失败；它不是所有 OpenAI-compatible 模型都能接受的透传字段 (`packages/cli/src/services/pi/responseVerbosity.ts`, `packages/cli/src/services/pi/requestOptions.ts`)

## Architecture
- 所有 system 消息被拼成单个 `systemPrompt`，其他消息按角色投影；Blade 的消息 ID 与 metadata 不进入 Provider Context，避免 durable/runtime 标记污染请求和缓存身份 (`packages/cli/src/services/pi/contextAdapter.ts`)
- assistant history 被重建为 thinking、text、toolCall 的有序内容，tool result 统一投影为 `isError: false` 的文本结果；历史错误语义若需保留，必须先扩展 Blade 消息契约而不能只改 pi-ai 映射 (`packages/cli/src/services/pi/contextAdapter.ts`)
- `buildPiOptions()` 将 Provider 差异集中在 API 分支：tool choice、thinking、service tier 和 verbosity 分别映射为顶层选项或 payload transform，多个 transform 会串联而不是相互覆盖 (`packages/cli/src/services/pi/requestOptions.ts`)
- `streamPiModel()` 只把 `text_delta`、`thinking_delta`、完成的 `toolcall_end` 和 `done` 投影到 Blade；start 等中间事件只刷新 watchdog，不产生业务 chunk (`packages/cli/src/services/pi/streamAdapter.ts`)

## Decisions
- pi-ai 的自动重试固定关闭，传输适配层只负责一次物理流；是否重试、何时 fallback 和何时禁止重放由外层 `PiAIChatService` 决定 (`packages/cli/src/services/pi/requestOptions.ts`, `docs/reference/model-transport-recovery.md`)
- 流活性基于 pi-ai 语义事件而非 socket 字节；空 keepalive 不能无限续期无模型进展的请求，默认 30 秒告警、300 秒 idle failure (`packages/cli/src/services/pi/streamAdapter.ts`, `git:e6bd4e15`)

## Patterns
- OpenAI Responses、OpenAI Completions、Anthropic Messages、Google、Bedrock 与 Mistral 的 thinking/tool 参数形状不同；新增 API 类型必须同时检查关闭 thinking 和强制 tool choice 两条分支 (`packages/cli/src/services/pi/requestOptions.ts`)
- Anthropic `fast` tier 同时需要配置解析阶段合并 `anthropic-beta: fast-mode-2026-02-01`，以及 payload 阶段写入 `speed: fast`；只改一侧会形成不可用请求 (`packages/cli/src/services/pi/resolveModelConfig.ts`, `packages/cli/src/services/pi/requestOptions.ts`)
- 远程 HTTP(S) 图片在发请求前下载并转成 base64，data URL 直接解码，其他 scheme 变成占位文本；下载使用同一 caller `AbortSignal` (`packages/cli/src/services/pi/contextAdapter.ts`)

## Provider Response Semantics
- `usage.promptTokens` 是普通 input、cache read 和 cache write 三个 bucket 之和，费用直接采用 pi-ai 的阶梯/缓存价格结果，不能再次按总 prompt token 套输入单价 (`packages/cli/src/services/pi/requestOptions.ts`)
- 可观测 API 同时安装 pi-ai `onResponse` hook 与 fetch 包装以捕获 status、`Retry-After`、`Retry-After-Ms` 和 `X-Should-Retry`；下游重试分类优先尊重显式 `X-Should-Retry: false` (`packages/cli/src/services/pi/requestOptions.ts`, `packages/cli/src/services/pi/providerRetry.ts`)
- stall 告警时间会被限制到 idle timeout 的一半以内，配置为 `0` 才完全关闭告警；因此缩短 idle timeout 也会隐式提前默认告警 (`packages/cli/src/services/pi/streamAdapter.ts`)
