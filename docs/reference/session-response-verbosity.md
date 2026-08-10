# Session Response Verbosity

Blade 将 Provider 原生响应详略作为 Session 自己拥有的 durable 配置，而不是进程全局
开关或仅影响系统提示词的展示偏好。同一进程中的 TUI、Web、ACP 和并发 Session 可以
选择不同详略；Runtime 重建、任务重试、fork 与 subagent 继承后仍保持原选择。

## 选择与能力

公开选择值为：

```text
auto
low
medium
high
```

- `auto`：不发送覆盖值，保留 Provider 或模型默认策略；
- `low`：请求紧凑响应；
- `medium`：请求平衡响应；
- `high`：请求更完整、更详细的响应。

显式选择不会被静默丢弃或降级。当前模型不支持原生 verbosity 时，切换会在替换
Provider service 前失败；fallback 模型也必须重新通过相同能力校验。

Blade 当前对以下模型暴露显式选择：

- `openai-codex-responses` 模型；
- 使用 OpenAI Chat Completions、Responses 或 Azure OpenAI Responses 的 GPT-5
  系列模型。

其他模型只提供 `auto`。`GET /models` 对每个模型投影：

```json
{
  "supportedResponseVerbosities": ["low", "medium", "high"]
}
```

Web 和 ACP 只展示当前模型实际支持的显式值。

## TUI

```text
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`/detail` 是 `/verbosity` 的别名。无参数时显示 selected、effective 和 supported
values；活动回合期间不能切换。状态栏对非 `auto` 选择显示 `Output low`、
`Output medium` 或 `Output high`。

## Web

Task Home 和 Session Composer 在模型、推理强度和服务等级旁提供自定义 Popover。
任务派发与消息请求发送同一个 `responseVerbosity`：

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "standard",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

切换到不支持当前显式值的模型时，Composer 回到 `auto`，不会继续显示无法执行的
选择。`session.updated`、catalog 恢复和 fresh page load 都从 durable Session
metadata 恢复选择。

## ACP

ACP Session setup 暴露标准 select config option：

```text
id: response_verbosity
category: model
```

客户端通过 `session/set_config_option` 切换。选项和当前值与 model、
`reasoning_effort`、`service_tier`、`communication_style` config option 一起返回，
不需要 Blade 私有扩展。

## 原子切换

模型、推理强度、服务等级、响应详略和沟通风格组成同一个 Session 设置组：

1. 针对目标模型校验四个 Session 控制项；
2. 创建并初始化新的 Provider service；
3. 原子替换 Runtime 中的旧 service；
4. 在一条 `session_updated` 中持久化模型和四个选择值；
5. 发布一次 `session.updated`。

活动回合期间不能切换五者。durable 写入失败时，Blade 用之前的
model/effort/tier/verbosity/style 五元设置恢复 Runtime；新 Provider 初始化失败时旧
service 保持可用。JSONL 只保存用户选择，不保存可重新计算的 effective 或 Provider
value。

Skill 临时模型覆盖、Task、Team、background/resume、retry 和 fork 都继承当前
Session 的响应详略。目标或 fallback 模型不支持显式值时 fail closed，而不是丢弃
verbosity 继续执行。

## Provider 映射

| Provider API | 请求投影 |
|--------------|----------|
| OpenAI Chat Completions | 顶层 `verbosity` |
| OpenAI/Azure Responses | `text.verbosity` |
| OpenAI Codex Responses | pi-ai `textVerbosity` |

Responses payload 已有 `text.format` 时，Blade 合并 `verbosity` 而不是覆盖格式。
service-tier 和 verbosity payload hook 也会组合执行，二者不能互相丢失。

## 生产资格

确定性测试必须覆盖完整 vocabulary、模型能力投影、unsupported 与 fallback fail
closed、三种 Provider payload 映射、payload hook 合并、Runtime service 原子替换、
active-turn 拒绝、JSONL 恢复、fork/retry/subagent 继承、持久化失败回滚、Web
Popover、TUI slash routing 和 ACP config option。

真实 GPT 资格通过不记录 Authorization 的本地透明代理完成两轮请求。第一轮必须使用
`low + fast + low`，销毁 Runtime 后从 durable metadata 恢复
`high + standard + high` 完成第二轮；代理必须分别直接观察到：

```json
{
  "reasoning_effort": "low",
  "service_tier": "priority",
  "verbosity": "low"
}
{
  "reasoning_effort": "high",
  "service_tier": "default",
  "verbosity": "high"
}
```

production Web GUI 必须从 Task Home 完成第一轮，再从 Session Composer 切换后完成
第二轮；fresh load 必须恢复完整消息和 `high + standard + high`。两次 upstream
响应都必须为 `200 text/event-stream`，JSONL、request body 与 UI 三方一致，证据文件
不得包含 API key。
