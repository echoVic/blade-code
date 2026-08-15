# Surface 输出背压与排序

Blade Code 把 canonical Runtime 状态与用户界面 transport 分开管理。JSONL commit、
Session lease 和 Agent run 由 Runtime 持有；Headless、Web SSE 与 ACP 只负责把已产生的
事件有界、有序地投影给消费者。一个慢或断开的 viewer 不能反向取消 server-owned run，
也不能让其他消费者的内存或延迟无界增长。

## 共享队列契约

每个 transport 使用单写者 FIFO，并同时限制条目数和 UTF-8 字节数：

- 最多 256 条 pending item；
- 最多 8 MiB pending bytes；
- active write 与尚未开始的 item 共同计入容量；
- 单次 write 最多等待 30 秒；
- `flush()` 等待调用时已经接纳的 high-water sequence，不等待之后的新事件；
- overflow、oversized item、timeout、abort、closed writer 和 writer rejection 都会
  fail closed。

普通事件不会为了维持连接而静默丢弃。容量耗尽代表 transport failure：关闭对应
subscriber 或 surface turn，并保留 canonical Session 事实供后续 reload/resume。
Heartbeat 仅在 Web egress idle 时发送，不占用普通事件的容量。

## Web SSE

Session stream 使用以下原子初始化顺序：

1. 先订阅 live Bus，并在 bounded buffer 中暂存初始化期间的事件；
2. 写入 connected frame；
3. 按 committed `seq` 串行 replay JSONL；
4. 去除 replay 已覆盖的 live duplicate，按 `seq` 排序剩余 committed event；
5. 切换为 live 模式，并拒绝后续 sequence regression。

`Last-Event-ID` 只以 durable committed sequence 为权威。Ephemeral delta 不参与 resume
cursor；replay 窗口中的旧 delta 会被丢弃。一个 subscriber overflow 或写超时只逐出该
subscriber，Session 的 server-owned Agent run 和其他快 subscriber 继续运行。

Web Store 在拉取 history 前先打开并缓冲 EventSource，snapshot ready 后原子提交并重放
缓冲事件，避免 snapshot/subscribe 之间的空窗。最终 `session.completed`、
`session.error` 或 `run.cancelled` 会触发一次合并的 authoritative message resync；
仅 durable lifecycle marker 不重复替换 DOM。

## ACP

一个 `AcpSession` 只有一条底层 `connection.sessionUpdate()` 写路径。content、
thinking、tool update、slash command、user-shell 和 metadata 全部进入同一 FIFO：

- 任意时刻最多一个 update in-flight；
- Agent generator 在每个 LoopEvent 后等待 queue flush；
- prompt、slash command 和 user-shell 在最终 update 写完后才返回；
- timeout、overflow 或 connection abort 会取消当前工作，不继续产生更新；
- transport failure 不通过 fake `user_message_chunk` 伪造恢复输入。

## Headless

stdout 与 stderr 各自拥有独立 FIFO 和容量。Node writable 返回 `false` 时，Headless
等待 `drain`，同时监听 `error` 与 turn `AbortSignal`；没有可观察 drain 契约的 writer
会立即 fail closed。

每个 Agent LoopEvent、user-shell 输出边界、warning/error 和 terminal phase 都在继续
或返回前 flush。`EPIPE`、closed writer、write timeout 或 abort 会终止当前 turn，清除
drain/error/abort listener，并使 `runHeadless()` 返回失败。

## TUI

TUI 的本地 React/Ink projection 不经过远端 egress queue，因此 Web viewer 或 ACP IDE
变慢不会拖住本地渲染。真实 raw PTY 资格测试会暂停 host reader，再恢复消费并验证最终
输出继续渲染；该测试验证终端管道行为，不把 PTY reader pause 当作 Agent backpressure。

## 验证边界

确定性测试覆盖 FIFO、UTF-8 accounting、active-write 容量、flush high-water、
timeout/abort、Web replay/live cutover、慢 subscriber 隔离、ACP single in-flight 与
Headless drain/EPIPE。发布阻断真实 API 进一步运行 DeepSeek Flash/Pro × Headless、
raw PTY TUI、production Chromium Web GUI 与真实 ACP 八格矩阵。
