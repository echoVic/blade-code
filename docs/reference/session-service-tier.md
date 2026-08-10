# Session Service Tier

Blade 将推理服务等级作为 Session 自己拥有的 durable 配置，而不是进程全局开关。
同一进程中的 TUI、Web、ACP 和并发 Session 可以选择不同等级；Runtime 重建、任务
重试、fork 与 subagent 继承后仍保持原选择。

服务等级会影响 Provider 的价格、排队和延迟语义。Blade 不会在 Provider 拒绝、
限流或不支持时静默改用其他等级。

## 选择与能力

公开选择值为：

```text
auto
standard
fast
flex
```

- `auto`：不发送覆盖值，保留 Provider 或模型的默认策略；
- `standard`：显式回到基线服务；
- `fast`：请求 Provider 的低延迟或优先通道；
- `flex`：请求 Provider 的低成本、可延迟通道。

显式选择不会被静默降级。当前模型不支持所选等级时，切换在替换 Provider service
之前失败。所有模型都支持 `standard`；OpenAI-compatible 模型支持
`standard/fast/flex`；支持 Claude Fast Mode 的 Claude Opus 4.6 支持
`standard/fast`。

`GET /models` 对每个模型投影：

```json
{
  "supportedServiceTiers": ["standard", "fast", "flex"]
}
```

Web 和 ACP 只展示当前模型实际支持的显式等级。

## TUI

```text
/speed
/speed auto
/speed standard
/speed fast
/speed flex
/fast
/fast on
/fast off
```

无参数 `/speed` 显示 selected、effective、Provider value 和 supported tiers。
`/fast` 是快速入口：无参数显示状态，`on` 选择 `fast`，`off` 选择
`standard`。状态栏对非 `auto` 选择显示 `Speed fast`、`Speed standard` 或
`Speed flex`。

## Web

Task Home 和 Session Composer 的模型与推理强度选择器旁提供自定义 Popover。任务
派发和消息请求发送同一个 `serviceTier`：

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "fast",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

切换到不支持当前显式等级的模型时，Composer 回到 `auto`，不会把 `fast` 显示为
其他等级。`session.updated`、catalog 恢复与 fresh page load 都从 durable Session
metadata 恢复选择。

## ACP

ACP Session setup 暴露标准 select config option：

```text
id: service_tier
category: model
```

客户端通过 `session/set_config_option` 切换。选项和当前值与 model、
`reasoning_effort`、`response_verbosity`、`communication_style` config option 一起
返回，不需要 Blade 私有扩展。

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
Session 的服务等级。目标模型不支持显式等级时 fail closed，而不是丢弃等级继续执行。

## Provider 映射

| Blade 选择 | OpenAI Responses/Completions | Claude Opus 4.6 |
|------------|------------------------------|-----------------|
| `auto` | 不覆盖 | 不覆盖 |
| `standard` | `service_tier: "default"` | 不发送 fast 配置 |
| `fast` | `service_tier: "priority"` | `speed: "fast"` |
| `flex` | `service_tier: "flex"` | 不支持 |

Claude `fast` 还会合并 `anthropic-beta: fast-mode-2026-02-01`，不会覆盖模型已有
beta header。OpenAI Responses 使用 pi-ai 的结构化 `serviceTier` option；
Chat Completions 和 Anthropic 通过 payload hook 投影请求字段。

## 生产资格

确定性测试必须覆盖完整 vocabulary、模型能力投影、unsupported fail closed、
Provider payload/header 映射、Runtime service 原子替换、active-turn 拒绝、JSONL
恢复、fork/retry/subagent 继承、持久化失败回滚、Web Popover、TUI slash routing
和 ACP config option。

真实 GPT 资格通过不记录 Authorization 的本地透明代理完成两轮请求。第一轮必须使用
`low + fast + low`，销毁 Runtime 后从 durable metadata 恢复为
`high + standard + high` 完成第二轮；代理必须分别直接观察到：

```json
{ "reasoning_effort": "low", "service_tier": "priority", "verbosity": "low" }
{ "reasoning_effort": "high", "service_tier": "default", "verbosity": "high" }
```

production Web GUI 必须从 Task Home 以 `low + fast + low` 完成首轮，再从 Session
Composer 切换到 `high + standard + high` 完成后续轮；fresh load 必须同时恢复完整
消息和 Session 设置。响应、JSONL 和 request body 三方一致，两次 upstream 响应都
必须为 `200 text/event-stream`，证据文件不得包含 API key。
