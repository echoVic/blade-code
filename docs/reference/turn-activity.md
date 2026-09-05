# 当前回合活动状态

Blade Code 由 `SessionRuntime` 统一维护当前顶层回合的瞬态活动状态，并把同一份投影提供给 TUI、Web、ACP 与 Headless。客户端不再根据零散事件自行猜测“正在做什么”。

## 状态与展示

活动阶段是封闭集合：

- `starting`：回合已创建，尚未进入模型循环；
- `thinking`：模型正在推理或准备下一步；
- `responding`：模型已经开始输出最终内容；
- `executing_tools`：至少一个工具仍在执行；
- `compacting`：正在压缩上下文；
- `continuing`：工具完成、follow-up 或 Goal continuation 正在推进。

投影还包含回合号、可选最大回合数、工具启动与完成计数、最多 8 个活动工具以及溢出计数。工具只公开净化后的名称、类型、开始时间和可选数字进度；耗时由客户端根据 `startedAt` 计算，不需要每秒发送协议事件。无限回合上限会表示为 `null`。

TUI 在 loading 区显示阶段、活动工具、工具/回合计数、耗时和 Esc 提示。Web 在 composer 上方显示紧凑的 `role=status`、`aria-live=polite` 状态条。界面优先级为：待处理交互、Provider recovery、action stationarity、当前回合活动、通用 loading 文案；高优先级状态出现时不会重复显示通用 activity。

## 生命周期与重连

每个顶层回合创建一个新的 `generation`，语义变化递增 `revision`。旧 generation、旧 revision，以及没有 revision `0` 锚点的迟到 live generation 都不能覆盖当前状态。完成、失败、取消、consumer 提前关闭或 Runtime dispose 会发布 `snapshot: null`，并使旧 generation 失效。

Web SSE 的 `connected.properties.turnActivity` 是权威快照。页面刷新或 EventSource 重连发生在工具执行期间时，Web 会先恢复该快照，再接收后续 live revision；空闲且没有 resident Runtime 的 Session 明确得到 `null`。

## 协议表面

- TUI/内部 Agent stream：`turn_activity`；
- Web Session Bus/SSE：`turn.activity`，连接帧使用 `turnActivity`；
- ACP：`session_info_update._meta['blade/turnActivity']`；
- Headless JSONL：`type: "turn_activity"`，字段使用 snake_case，终态为 `snapshot: null`；
- Headless 文本模式不打印 activity，避免长任务进度刷屏。

Runtime 通过 Session Bus 发布 ACP/Web 权威事件；ACP 会去除相同 generation/revision 的重复投影，direct Agent stream 不会二次发送同一元数据。

## 隐私边界

活动状态不会持久化到 transcript，也不会包含工具参数、命令、输出、文件路径、prompt、URL、错误正文、进度消息或凭据。未知字段、非法计数、过长名称和不一致进度会由 TypeBox schema 拒绝或在 Runtime 归约时忽略。
