# Session Reasoning Effort

Blade 将推理强度作为 Session 自己拥有的 durable 配置，而不是进程全局开关。同一进程中
的 TUI、Web、ACP 和并发 Session 可以选择不同强度，Runtime 重建、任务重试、fork 与
subagent 继承后仍保持原选择。

## 选择与能力

公开选择值为：

```text
auto
off
minimal
low
medium
high
xhigh
max
```

`auto` 是一个持久策略值。每次创建 Provider 时，Blade 根据当前模型的
`thinkingLevelMap` 在接近 `high` 的位置解析 effective level；切换模型后可以得到不同
effective level，但 UI 仍显示 `auto`。

显式级别不会被静默降级。模型不支持所选级别时，切换在替换当前 Provider 前失败。
不支持推理的模型只提供 `auto` 与 `off`，其中 `auto` 解析为 `off`。要求始终推理的模型
可以拒绝 `off`。

`GET /models` 对每个模型投影：

```json
{
  "supportedReasoningEfforts": ["off", "low", "medium", "high"]
}
```

Web 和 ACP 只展示当前模型实际支持的显式级别。

## TUI

```text
/effort
/effort auto
/effort off
/effort minimal
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

无参数时显示 selected、effective 和 supported levels。`Tab` 保留快速开关语义：
`off` 与 `auto` 之间切换；精确强度使用 `/effort <level>`。状态栏显示当前选择，例如
`Effort high`。

## Web

Task Home 和 Session Composer 的模型选择器旁提供自定义 Popover。任务派发和消息请求
都发送同一个 `reasoningEffort`：

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "standard",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

切换到不支持当前显式级别的模型时，Composer 回到 `auto`，不会偷偷把 `high` 显示为
另一个显式级别。`session.updated`、catalog 恢复与 fresh page load 都从 durable
Session metadata 恢复选择。

## ACP

ACP Session setup 暴露标准 select config option：

```text
id: reasoning_effort
category: model
```

客户端通过 `session/set_config_option` 切换。选项和当前值与模型、
`service_tier`、`response_verbosity`、`communication_style` config option 一起返回；
ACP host 不需要 Blade 私有扩展。

## 原子切换

模型、推理强度、服务等级、响应详略和沟通风格组成同一个 Session 设置组：

1. 先针对目标模型校验四个 Session 控制项；
2. 创建并初始化新的 Provider service；
3. 原子替换 Runtime 中的旧 service；
4. 在一条 `session_updated` 中持久化模型与四个选择值；
5. 发布一次 `session.updated`。

活动回合期间不能切换五者。若 durable 写入失败，Blade 用之前的
model/effort/tier/verbosity/style 五元设置恢复 Runtime；若新 Provider 初始化失败，
旧 service 保持可用。JSONL 只保存用户选择，不保存可由模型能力重新计算的 effective
值。

## Provider 映射

effective level 通过 pi-ai 的模型 catalog 与 Provider option 投影：

- OpenAI Responses/Completions：`reasoning_effort`；
- Anthropic Messages：thinking enabled 与 effort；
- Google Generative AI：thinking enabled 与映射后的 level；
- Bedrock/pi-messages：reasoning level；
- Mistral：模型支持的高推理模式。

工具续写若缺少 Provider 要求的 thinking signature，现有兼容性保护仍可对该次请求
关闭 reasoning；这不会改写 Session 选择。

## 生产资格

确定性测试必须覆盖完整 vocabulary、模型能力投影、unsupported fail closed、
Runtime service 原子替换、active-turn 拒绝、JSONL 恢复、fork/retry 继承、持久化失败
回滚、Web Popover、TUI slash routing 和 ACP config option。

真实 GPT 资格在本地透明代理中记录请求 JSON，不记录 Authorization header。轨迹先以
`low + fast + low` 完成真实请求，销毁 Runtime，把 durable Session 更新为
`high + standard + high`，重建后完成第二次请求；代理必须分别观察到：

```json
{ "reasoning_effort": "low", "service_tier": "priority", "verbosity": "low" }
{ "reasoning_effort": "high", "service_tier": "default", "verbosity": "high" }
```

production Web GUI 必须完成 Task Home `low` 首轮、Session Composer `high` 后续轮和
fresh load Session 设置恢复；响应、JSONL 与代理 request body 三方一致，证据文件
不得包含 API key。
