# Session Communication Style

Blade 将沟通风格作为 Session 自己拥有的 durable 配置。它控制回答的语气和解释框架，
不改变模型推理强度、Provider 服务等级或原生响应详略。同一进程中的 TUI、Web、ACP
和并发 Session 可以使用不同风格；Runtime 重建、任务重试、fork 与 subagent 继承后
仍保持原选择。

## 选择与语义

公开选择值为：

```text
auto
pragmatic
friendly
explanatory
user:<name>
project:<name>
plugin:<plugin>:<name>
```

- `auto`：不追加风格 section，保留 Blade 默认沟通规则；
- `pragmatic`：直接、事实导向、简洁且强调行动；
- `friendly`：温和协作，但仍保持事实和任务导向；
- `explanatory`：简要解释代码库特定的实现选择与工程取舍。
- namespaced custom style：从可信 user、project 或 active plugin catalog 解析。

`communicationStyle` 与 `responseVerbosity` 正交。前者影响表达方式，后者通过模型原生
参数影响输出密度。例如，可以同时选择 `pragmatic + high` 或
`explanatory + low`。

自定义 style 只接受 catalog ID，不接受任意文件路径、JSON 或 prompt 文本。来源目录、
Workspace Trust、预算、provenance 与 Session 快照契约见
[Trusted Custom Output Styles](trusted-output-styles.md)。

## Prompt 边界

显式风格在默认或 Plan prompt 之后、可信项目指令之前加入独立 section：

```text
<communication_style>
...
</communication_style>
```

section 明确只能控制语气和解释框架，不能修改：

- 任务范围与完成条件；
- 安全与权限规则；
- 工具行为和审批；
- 指令来源优先级。

更具体的用户展示要求可以覆盖当前回答的表达方式。`auto` 不生成该 section。

## TUI

```text
/style
/style auto
/style pragmatic
/style friendly
/style explanatory
/style project:review:strict
/personality friendly
```

`/personality` 是 `/style` 的别名。无参数时显示 selected 与 effective 值；活动回合
期间不能切换。状态栏对非 `auto` 选择显示 `Style pragmatic` 等状态。

## Web

Task Home 和 Session Composer 在 inference controls 旁提供自定义 Popover。任务派发
与消息请求发送同一个 `communicationStyle`：

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "standard",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

`session.updated`、catalog 恢复和 fresh page load 都从 durable Session metadata
恢复选择。Web 只接收 custom style 的安全摘要，不接收 prompt 或宿主路径。活动回合
中控件锁定，避免当前请求使用一半旧配置、一半新配置。

## ACP

ACP Session setup 暴露标准 select config option：

```text
id: communication_style
category: model
```

客户端通过 `session/set_config_option` 切换。选项由 Session catalog 动态生成，和
当前值与 model、
`reasoning_effort`、`service_tier`、`response_verbosity` 一起返回，不需要 Blade
私有扩展。

## 原子持久化

模型、推理强度、服务等级、响应详略和沟通风格组成同一个 Session 设置组：

1. 先校验所有请求值；
2. 需要时原子替换 Provider service；
3. 更新 Runtime 的 style selection；
4. 在一条 `session_updated` 中持久化全部变化；
5. 发布一次 `session.updated`。

仅切换沟通风格不会重建 Provider。若 durable 写入失败，Blade 恢复之前的五元设置；
若 Provider 初始化失败，旧 service 与旧 style 都保持可用。

Task、Team、background/resume、retry、fork 和直接 subagent resume 都继承父 Session
的沟通风格。子 Session 拥有自己的 durable selection，之后可以独立切换。

custom selection 额外持久化 prompt SHA-256。Runtime 重建时 ID 缺失或 digest 漂移会
在模型请求前 fail closed；显式切换到内置 style 可以清除旧 provenance。

## 生产资格

确定性测试必须覆盖完整 vocabulary、prompt section 顺序与权限 guard、`auto` 无注入、
Runtime 切换不重建 Provider、active-turn 拒绝、JSONL create/update/fork、metadata
失败补偿回滚、Task/Team/background/resume 继承、TUI slash/status、Web Popover/SSE
projection 和 ACP config option。

真实 GPT 资格通过不记录 Authorization 的本地透明代理完成两轮请求。第一轮必须使用
`pragmatic`，销毁 Runtime 后从 durable metadata 恢复为 `explanatory` 完成第二轮；
代理必须在实际 `system` 或 `developer` message 中直接观察到对应 section 与权限
guard。

production Web GUI 必须从 Task Home 完成 `pragmatic` 首轮，再从 Session Composer
切换到 `explanatory` 完成后续轮；fresh load 必须恢复完整消息和
`explanatory`。两次 upstream 响应都必须为 `200 text/event-stream`，JSONL、request
body 与 UI 三方一致，证据文件不得包含 API key。
