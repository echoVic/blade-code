# 模型传输恢复

Blade Code 在 `PiAIChatService` 中统一拥有模型请求的重试策略。pi-ai provider 的自动重试固定为 `0`，避免 provider 与 Agent 各自重试导致请求次数相乘，也避免底层在 Blade 不知情时重放流式响应。

## 可重试错误

Blade 会遍历 `lastError` 和 `cause` 错误链，并把以下错误视为瞬时故障：

- HTTP `408`、`409`、`429` 和 `5xx`；
- 连接超时、DNS 暂时失败、连接重置或拒绝、socket 中断等网络错误；
- 错误消息或结构化字段中携带的同类状态和错误码。

`maxRetries` 表示首次请求之后最多追加的尝试次数。重试使用有界指数退避，等待期间响应当前 turn 的 `AbortSignal`，取消后不会再启动新请求。

上下文超限属于确定性错误。`prompt_too_long`、`maximum context length`、`context_length_exceeded` 等标记即使被网关包装成 HTTP `500`，也不会进入传输重试或模型 fallback，而是返回 Agent loop 触发反应式压缩。

## 流式重放边界

只有尚未向 Agent loop 交付任何 `StreamChunk` 的尝试可以重试。以下任一事件出现后，本次请求就越过重放边界：

- 文本或 reasoning 增量；
- 完整工具调用；
- usage 或 finish 事件。

越过边界后发生的错误会直接上抛，不会从头请求当前模型，也不会切换 fallback 模型。这个限制同时保护终端输出和流式工具执行器：只读工具可能在流结束前预启动，重放同一 tool call 仍可能产生重复网络访问、重复 transcript 事件或状态竞争。

主模型在零输出状态下耗尽重试后，才允许进入配置的 fallback 模型。fallback 一旦产出 chunk，同样禁止继续切换其他模型。

## 设计依据与验证

该边界综合了 Codex 的集中式 stream retry、Claude Code 的前台有界恢复、Neovate Code 的可取消指数退避，以及 Grok Build 对确定性和瞬时错误的显式分类。Blade 额外把自身的流式工具预启动纳入重放判定，因此以首个对外 chunk 作为提交边界。

单元测试覆盖错误分类、provider 重试所有权、部分文本、工具调用和 abort。生产资格门禁还会为每个 DeepSeek 模型启动本地故障注入代理：首个真实 CLI 模型请求返回一次 HTTP `503`，后续请求转发到真实 API；轨迹必须完成代码修改、Bash 验证、diff 范围检查和宿主侧测试。
