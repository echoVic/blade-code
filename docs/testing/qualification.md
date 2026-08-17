# Blade Code 测试手段与生产准出

Blade Code 将确定性回归与付费模型验证分成两道门禁。两道门禁都必须通过，才可以把一个功能 patch 标记为生产就绪。

## 本地门禁

在仓库根目录执行：

```bash
bun run qualify:local
```

命令会按固定顺序执行 14 个检查：

1. `type-check`
2. `format:check`
3. `lint`
4. 单元测试
5. 集成测试
6. CLI 集成测试
7. headless/runtime 核心回归
8. E2E
9. snapshot
10. 安全测试
11. 当前源码构建
12. Web 测试
13. Web 类型检查
14. 性能回归

每一步都在独立子进程中执行。第一步非零退出会立即停止，后续步骤不会被计为通过。该门禁不访问付费模型，也不依赖 `~/.blade/config.json`。

GitHub `Quality Gate` 在 build 前重复执行全仓 format check 与 CLI lint，并由 workflow
source contract 固定 install → format → lint → build 顺序。root、CLI 与 Web 使用同一
精确 Biome 版本，避免 workspace binary 解析差异让本地门禁和 CI 得到不同结果。

V8 coverage 通过 `bun run --filter blade-code test:coverage` 单独执行。coverage
编排覆盖 unit、integration、CLI、E2E、snapshot、security 和不需凭证的 real-api
fixtures，但显式排除 wall-clock `performance` project；instrumentation 与并行项目负载
会使启动耗时失去可比性。性能回归仍是 `qualify:local` 在 production build 之后的必需项。

## 真实 API 门禁

真实 API 门禁必须使用当前源码刚构建的 `packages/cli/dist/blade.js`。Provider
credential 可以由 secret manager 注入测试子进程环境，也可以放在测试专用的
`~/.blade/real-api-credentials.json`。后者必须是当前用户拥有的普通文件且权限为
`0600`；符号链接、宽松权限、未知字段和超过 64 KiB 的文件都会 fail closed。不要把
真实值写成 inline `KEY=value`、执行 `export` 留在 shell history，或复制到证据文档。
命令记录只保留变量名、模型 ID 和是否存在，不记录变量值。环境准备完成后执行：

```bash
bun run --filter blade-code browser:install # 首次或 Playwright 版本变化后
bun run --filter blade-code browser:check
bun run qualify:production
```

`browser:check` 不联网、不隐式下载，只验证锁定 Playwright 版本的 Chromium executable
可执行并能 launch/close。production qualification 固定执行 16 个检查：14 个本地门禁、
无密钥 Chromium preflight、最后才是付费真实 API；preflight 失败时不得启动 Provider
请求。浏览器页只访问 loopback Blade server，API key 不进入 page context。

每条 capability 轨迹的 Provider request timeout 与 silent-stream idle timeout 必须
同时短于 Vitest test timeout，并为 abort、runtime dispose、临时目录删除和全局配置
恢复保留确定性清理窗口。验证 permission
recovery 的轨迹关闭 Provider retry；retry/backoff 只在专用故障注入轨迹中测试，避免
测试框架 timeout 后旧 `finally` 与 Vitest retry 并发运行。permission recovery 的
Write 资格使用唯一绝对 `file_path` 与 Write-only 工具白名单，text-only 回答不能替代
真实文件副作用。

该命令运行固定的 release-blocking real matrix：真实 DeepSeek Flash/Pro Headless
bugfix、GPT Web structured output、Claude ACP structured output、DeepSeek headless
structured output、Web/ACP/TUI code review、durable interaction recovery、permission
recovery、ACP model switch、ACP durable fork Write+Bash capability routing、透明 503
retry proxy、durable 413 compaction proxy、真实 mid-stream stall proxy、assistant
response fsync fail-stop/cold retry、turn-final receipt exactly-once recovery、
foreground/background shell hard-crash recovery，以及 DeepSeek Flash 的
Runtime/Web/ACP host-authoritative Goal completion verification。ACP fork 固定要求
DeepSeek Flash/Pro，并对当前资格环境中已配置的 Claude、GPT 与国产模型执行同一 paired
SDK trajectory；未声明 terminal capability 的 Client 必须使用 Session-bound local
terminal，声明后 terminal 失败仍须 fail closed。
Goal completion 的 fresh PASS authority 同时绑定当前 host run、mutation revision 与
由 Goal ID、attempt、requested-at timestamp 组成的 completion candidate identity。
模型重复提交相同的幂等 `UpdateGoal complete` 时，必须保留已经由该 host run 记录的
verifier Session ID、verdict、evidence digest 与 finalization snapshot；候选变化、
workspace mutation 或进程重启才能使 receipt 失效，不能因重复候选额外消耗
verification retry budget。
前台有界输出固定运行 DeepSeek Flash/Pro × Headless/production Chromium Web/raw PTY
TUI/真实 ACP SDK terminal 八格；单格 Provider deadline 180 秒、测试 timeout 240 秒，
完整 realApiQualification watchdog 为 60 分钟，发布矩阵固定 framework `retry=0`。
每格还验证 surface egress：Headless
等待 `write(false) -> drain`，ACP 最多一个 `sessionUpdate()` in-flight，raw PTY 暂停
reader 后继续渲染，Web 在运行中 reload 后按 durable cursor 恢复同一 tool/final state。
raw PTY 必须锁存已经观察到的 final marker、stdout/stderr retained tail 和 truncation
notice，不能让 resize redraw 轮换有界终端窗口后反向抹除已成立证据；同时必须从 resize
后的新 PTY 数据再次观察 truncation notice，不能用 resize 前的历史命中放行。
模型的整个最终响应必须严格等于单格 marker；ACP 失败诊断只能保留有界、脱敏的最终文本
预览，不能用放宽 marker 或 framework retry 掩盖模型偏离。
Root-turn crash auto-resume 另固定运行
DeepSeek Flash/Pro × Headless/raw PTY TUI/production Chromium Web/真实 ACP
`session/load` 八格，所有入口都不得依赖额外 wake-up prompt。最终响应 token 必须与
恢复 prompt、marker 文件和 Read output 区分，且不能在 prompt 中完整出现，也不得用
重复词段制造无关的 Provider 拼写歧义；Web 已观察到恢复前缀但完整 token 不匹配时必须
立即输出有界、脱敏的 assistant 文本，不能退化为固定 180 秒 locator 超时。raw PTY
必须按精确 inbox message ID 观察 acknowledgement，以及同一 turn 随后的
`turn_completed`，不能以终端历史命中或固定等待窗口代替 durable terminal。ACP
多 Provider 对照的终答窗口必须晚于 180 秒 runtime hard timeout，并为销毁连接与临时
目录清理保留剩余测试窗口；ACP fork 的 parent Read 与 child Write/Bash 是两个顺序
prompt stage，每段由宿主 180 秒 deadline 发送标准 `session/cancel` 并等待 prompt
收敛；外层预算固定为 420 秒，只覆盖两个 stage deadline 和 60 秒清理余量。不得通过
Provider 或 framework retry 延长。Edit+rewind、
Goal finalization crash handoff 使用同一 Flash/Pro × 四入口八格矩阵，恢复阶段必须
零 Provider 请求，随后再从同一 surface 完成真实 API follow-up。PTY follow-up 用户输入
不得包含完整预期响应 marker；Provider request body 必须先解析 JSON `messages` 再验证
prompt，避免输入回显伪装 assistant completion。Completed-subagent
adoption 与 background-subagent completion wake-up 也分别固定运行 Flash/Pro ×
Headless/raw PTY/production Chromium Web/真实 ACP 八格矩阵。
Bounded coordinated shutdown 另固定运行同一 Flash/Pro × 四入口八格矩阵；每格在真实
foreground Bash 进入 host-visible PID barrier 后发送 production `SIGTERM`，要求
exactly-one cancelled abort、同 Session 恢复、延迟副作用对照和全量资源回收。
开放式多文件迁移、compaction、进程树、
并发 owner 与 crash-tail 等高成本 provider/capability soak 由以下命令单独运行：

```bash
bun run test:real-api
```

国产模型通道属于可选 soak provider，不进入默认发布阻断矩阵。需要显式加入时设置
`REAL_API_INCLUDE_OPTIONAL_PROVIDERS=1`；余额不足或共享通道限流不会降低 DeepSeek、
Claude、GPT 的必需准出标准。下文按能力列出的扩展 required matrix 描述完整 soak
contract，不表示每个 patch 都要同步阻塞发布。

凭据文件格式如下，`baseURL` 和单模型 `model` 可省略：

```json
{
  "version": 1,
  "providers": {
    "deepseek": {
      "apiKey": "...",
      "baseURL": "https://api.deepseek.com",
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
    },
    "claude": {
      "apiKey": "...",
      "baseURL": "https://gateway.example.com",
      "model": "claude-opus-4-8"
    },
    "gpt": {
      "apiKey": "...",
      "baseURL": "https://gateway.example.com",
      "model": "gpt-5.5"
    },
    "domestic": {
      "apiKey": "...",
      "baseURL": "https://gateway.example.com",
      "model": "qwen3.8-max"
    }
  }
}
```

可通过 `BLADE_REAL_API_CREDENTIALS_FILE` 指向其他文件。显式 Provider 环境变量优先于
文件中的同名字段；只要命令环境中存在任一显式 API key 且没有显式指定凭据文件，该
环境变量集合就成为完整 allowlist，不会隐式合并默认凭据文件或个人模型。

`qualify:production` 在启动任何测试子进程前会 fail-closed 校验：

- DeepSeek key 必须来自显式环境、受限凭据文件或 `~/.blade/auth.json`；
- `DEEPSEEK_MODELS` 必须同时包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`；
- 未提供 `DEEPSEEK_BASE_URL` 时使用 `https://api.deepseek.com`；
- `DEEPSEEK_MODEL` 默认选择列表中的第一个模型，供单模型轨迹使用；
- Claude、GPT 与 domestic 资格配置会投影为独立 `modelProviders` 渠道；每个渠道使用
  自己的 provider-level endpoint 和专属进程凭据槽，同协议渠道不会串 key；
- API key 不写入项目配置、源码、命令参数、日志、JSONL 或快照。

release-blocking matrix 固定包含 DeepSeek Flash 和 Pro，并通过 Claude、GPT 验证
跨 provider 的 Web/ACP 结构化输出。完整 soak 中显式启用的 Claude、GPT 和 domestic
模型还必须通过基础 chat、streaming、usage、finish、tool calling，以及
Runtime、TUI、Web、ACP 四条 production entrypoint。仅收到文本或 HTTP `200` 不算通过。
跨端 fork 轨迹必须让 pi-ai 从自定义渠道解析凭据，不得通过模型级 `apiKey` 参数旁路。
渠道健康资格还会分别从 Web route、TUI `/doctor` 和 ACP callback 对 GPT、domestic、
Claude 发送最多 8 tokens 的真实 probe；结果必须使用 canonical failure 投影且不得
包含模型原文、原始错误或 API key。

Provider Retry 资格必须通过透明本地代理在第一次真实模型请求返回带
`Retry-After` 的 `429` 或 `503`，第二次请求原样转发到真实 Provider。单个用户 turn
必须在不依赖测试框架重跑的情况下完成真实工具修改与项目测试；Headless JSONL 必须
依次出现 sanitized `provider_retry` 的 `scheduled`、`attempt`、`recovered`，只产生
一次最终内容和一次工具副作用。确定性 transport 测试另行覆盖 jitter/cap、
HTTP-date、`retry-after-ms`、backoff cancellation、quota/context fail-fast、部分输出
后不重放、exhausted 与 fallback；Provider response body、headers 和 key 不得进入
LoopEvent、SSE、ACP、JSONL 或 transcript。Production Web GUI 必须在同一 Session
StatusBar 显示 retry attempt 与有界等待，随后无刷新完成，fresh tab 恢复最终结果且
browser console 无 application error。TUI 条件允许时通过 Computer Use 验证 loading
状态和 Esc 取消；ACP 必须通过 `session_info_update` metadata 投影且不污染 assistant
正文。

Bounded foreground Provider recovery 另固定运行 DeepSeek Flash/Pro × Headless、
真实 ACP stdio + child-backed terminal、raw PTY TUI 与 production Chromium Web GUI
八格矩阵。透明代理必须让前四个模型请求返回 replay-safe `503`，只将第五个请求原样
转发真实 Provider；因此旧默认 2 次 retry 无法通过。每格必须在同一 root turn 内：

- 按序投影 attempt `1,2,3,4` 与 recovered `4/12`；
- 携带 `mode=bounded_foreground`、总预算和非负 elapsed/remaining；
- 只执行一次 Edit 与一次 Bash，并由宿主再次运行 fixture 测试；
- 保持 Provider payload、transcript 与最终 workspace 不出现重复副作用；
- TUI 显示有界恢复与 Esc，ACP 只发 metadata，Web StatusBar 实时显示恢复并在完成后
  清除，reload 后保留最终结果；
- 回收 Provider proxy/socket、ACP terminal/process、PTY、browser/page、SSE、server、
  port、临时 HOME/storage/workspace；
- 不得把 Provider key、私有故障 body 或 raw error 写入 JSONL、SSE、ACP、DOM、终端
  capture、transcript 或测试证据。

确定性测试还必须覆盖 recovery deadline 在 backoff 与 in-flight stream 内获胜、
caller abort、12 次追加尝试硬上限、fallback 共享时钟、timer cleanup，以及 text、
reasoning、tool call、usage、finish 任一 chunk 后禁止重放。feature matrix 的发布证据
必须使用 `retry=0`。

Shared Provider circuit 复用同一八格矩阵，并将 Open 时间配置为合法的 `2000ms`
（production 默认 `10000ms`）。透明代理在第 4 个 `503` 完成后记录 monotonic boundary，
后续请求不得在 Open 窗口内到达；到期后只允许一个 HalfOpen probe。各入口必须按同一
typed schema 投影 `opened -> waiting -> probe -> closed`，TUI circuit 状态优先于普通
retry 文案，Web/ACP 不得把 metadata 写入 assistant 正文或 durable transcript。

Web 与 ACP 的 Flash/Pro cell 还必须在同一进程中启动第二个 Session。Session B 在
Session A 已 Open 后提交，Open 窗口内零 Provider 请求；两 Session 合计恰好一个首个
probe，关闭后分别取得独立真实 Provider 结果。Headless/TUI 不承载同进程多 Session，
其 cell 只验证单 Session 状态机与 surface 投影。全部八格与双 Session 控制使用
`retry=0`，并回收 secondary Session、SSE、terminal、browser/page、proxy 与临时目录。

Provider request admission 资格固定运行 DeepSeek Flash/Pro × Headless、真实 ACP、
raw PTY TUI 和 production Chromium Web 八格，测试配置使用合法的
`providerRequestConcurrency=1` 与 `providerRequestAdmissionMs=120000`。透明代理先把
一个已 admitted 的真实 Provider request 停在 host barrier；第二个同 domain request
必须先投影 `queued`，且代理在 release 前只能观察到一个请求。release 后第二个 request
按序投影 `admitted` 并取得独立真实 Provider 结果，代理最大同域 in-flight 必须恰好为
1。

Web/ACP cell 使用同进程双 Session 对照。Headless/TUI cell 使用 production background
Task child 持有 permit，parent 下一轮排队；child 与 parent 都必须访问真实 Provider，
允许代理只为确定性 Task trigger 生成 synthetic tool call。八格还必须验证 root owner
继承、零 framework retry、attempt 不包含 queue wait、metadata 不进入 assistant/transcript、
Web reload/ACP load 清除瞬态状态、TUI Esc 可见以及全量 proxy/browser/PTY/process/profile
回收。

Weighted Provider admission 另固定运行 DeepSeek Flash/Pro × Headless、真实 ACP、
raw PTY TUI 和 production Chromium Web 八格负向矩阵。测试配置在合法
`providerRequestPendingBytes=65536` 下先让一个大上下文 parent 或 Session A request
立即 active，再让同进程 background child 或 Session B 的大上下文进入等待；后者必须投影
`rejected/queue_full/pending_bytes`，且透明代理观察到零额外 Provider traffic。
Headless/TUI 使用 parent 持有 active permit、background child 被拒绝，并分别通过
schema-valid child JSONL 或“失败 sidecar + 可见 TUI failure”证明同一事实；Web/ACP
使用双 root Session。最终 queue-full turn 保留 failed abort 但确认本 turn 输入，
reload、SSE reconnect 或 ACP load 不得把 Session B marker 重放到 Provider。Web 必须从
真实 composer 提交并保持零 console/page error。TUI failure 必须由宿主的有界 terminal
summary 直接投影，不能依赖模型复述；raw PTY 在结束前还必须观察 hidden completion 已
ack，且其提交 seq 之后存在 `turn_completed`，避免 teardown 与 held proxy request 重叠。
全部八格使用 `retry=0`，
同时继续运行前述正常 queued→admitted 矩阵，防止 byte policy 把正常长任务缩窄为只会
fail closed。

Weighted top-level task admission 资格使用合法最小
`maxQueuedTaskBytes=65536`。DeepSeek Flash/Pro × production Chromium Task Home 和
真实 ACP stdio 四格负向 target 必须先让 task A 的真实 Provider request 停在 host
barrier，再提交包含唯一 marker 与大段非 ASCII 文本的 task B。B 必须以
`pending_bytes` 在 Provider traffic 前拒绝：Web 返回 typed HTTP 429、显示内联错误且
catalog/reload 无 ghost task；ACP 持久化并投影 retryable
`capacity/pending_bytes`，assistant 正文不含 admission metadata。随后普通小 task C
必须进入 queue position 1，并在 A 释放后取得独立真实 Provider 结果。代理请求 body
不得包含 B marker。Task Home 的 composer 可输入不代表 dispatch 已可用；Chromium
必须先观察显式 `data-blade-task-dispatch-ready=true`，该状态同时受 workspace 与 model
readiness 约束。readiness 超时必须输出结构化状态诊断，不得盲等 submit disabled 或通过
重载/重试绕过。

非干扰对照固定运行 Flash/Pro Headless `--task-isolation local` coding task 与 Flash/Pro
raw PTY root turn；全部在同一最小 byte limit 下完成。既有 production Web task
dispatch Flash/Pro worktree coding/FIFO trajectory继续 release-blocking。target 与
controls 全部使用 `retry=0`，并回收 rejected inbox/Runtime/worktree、accepted task、
browser、ACP process/terminal、proxy/socket、port、HOME/storage/workspace。Chromium
只允许预期的 `/tasks` 429 resource error，其他 console/page/request fault 必须为零。

Bounded Session Runtime residency 资格固定使用
`maxResidentSessionRuntimes=1` 与 `sessionRuntimeIdleMs=30000`。DeepSeek Flash/Pro
× production Chromium Web GUI 两格先持有 Session A 的真实 Provider 请求，再由
Session B 验证 typed HTTP 429 `resident_runtimes`、零 rejected marker Provider
traffic、idle LRU slot reuse 与 Session A durable cold follow-up。浏览器只允许预期
429 resource error，其他 console/page/request/SSE fault 必须为零。

真实 ACP stdio 两格必须广告并调用标准 `session/close`：active Session A 占满唯一
slot 时，new Session B 在 task/worktree/Runtime/Provider 副作用前收到 bounded
JSON-RPC capacity error；close A 取消并结算 prompt、确认 cancelled inbox、释放 slot，
随后 B 完成真实 turn，close B 后 load A 从 durable transcript 完成真实 follow-up。
Flash/Pro Headless 与 raw PTY 再各运行一格单 root coding control，证明 resident limit
不会干扰非 multiplexed Runtime。目标与对照共八格全部使用 `retry=0`，并检查
Runtime reservation、ACP/TUI process、Provider proxy、browser/profile、
HOME/storage/workspace 全量回收。

Provider Stall 资格必须让透明 SSE 代理先转发真实模型内容，再在 hard idle timeout
之前暂停后续事件。Headless JSONL 必须按同一 stall count 输出 sanitized
`detected → recovered`，标记 `output_started=true`，随后完成真实回复；代理必须证明
只收到一个 Provider 请求，且不能出现 retry、重叠 `iterator.next()`、重复内容或工具
副作用。确定性 transport 测试另行覆盖首事件前 stall、mid-stream stall、warning 后
hard timeout、caller abort、deadline reset 和 warning 后仍只有一个 pending read。
Production Web GUI 必须在 StatusBar 显示 stall duration/hard deadline，恢复后无刷新
完成且 console 无 application error；TUI 必须显示 stall 状态、hard deadline 与 Esc
取消入口；ACP 和 Headless 只投影 metadata，不污染 assistant 正文或 durable transcript。

Provider total-attempt deadline 资格必须先通过透明 SSE proxy 转发真实 DeepSeek Flash
content，再把 completion 延迟到 `timeout` 之后且 `streamIdleTimeout` 之前。Headless
必须在 45 秒 total deadline 产生 typed error、保留已交付 content、零 retry、单一
Provider request，并同步 abort proxy 的上游 fetch。Production Chromium Web 必须显示
同一 `[data-blade-session-error]`，证明 assistant partial content 可见、凭据不进入 DOM、
console/page fault 为零；terminal durable resync 只允许旧
`/sessions/:id/events` EventSource 产生恰好一次 `net::ERR_ABORTED`，其他 request fault
必须为零。browser、server、proxy、HOME/storage/workspace 必须全部回收。

Reactive Compaction 资格必须让透明代理在首个真实 turn 返回一次
`413 context_length_exceeded`，后续压缩摘要和恢复请求原样转发到真实 Provider。
runtime 必须在零输出 replay boundary 内发出 paired compaction lifecycle，先提交含
exact replacement messages 的 JSONL checkpoint，再重试同一 turn；不得产生
`provider_retry`、重复工具副作用或无限 compaction loop。第二个独立 Runtime 必须仅从
checkpoint model projection 恢复此前 marker，同时完整 transcript 仍可供 UI 展示。
Production Web GUI 必须显示“上下文超限，正在恢复…”，无刷新完成最终回复；fresh tab
恢复可见历史并继续回答 checkpoint marker，browser console 零 application error。
真实 raw PTY TUI 必须显示“压缩中”与 Esc 入口并完成同一 marker；ACP、Server SSE 和
Headless JSONL 只暴露 reason/strategy/outcome/token metadata，不外泄 Provider 错误体。

工具并发资格要求 GPT 在同一个 production stream 中同时调用两个已加载工具。两个
工具在执行函数内互相等待，只有都进入 shared gate 才能释放；因此单纯缩短总耗时或
顺序执行无法通过。确定性测试另行覆盖 exclusive FIFO、同路径文件锁、abort、fallback
epoch、Web 多卡刷新重建、TUI keyed progress 和 ACP 独立 tool-call ID。

Bounded fair tool admission 另固定运行 DeepSeek Flash/Pro × Headless、真实 ACP
stdio + PTY terminal、raw PTY TUI 与 production Chromium Web GUI 八格矩阵。模型必须
在单个 response 中发出四个真实 foreground Bash；host 在四条 canonical call 全部
提交后证明单 Session 初始只启动两项、第三/第四项等待、每释放一项只推进一个
successor、durable call/result 保持 Provider 顺序。独立的双 Session Chromium 轨迹
要求 Session A 占用两个 execute slot 并排队第三项时，Session B 使用剩余全局 slot
先完成；两个 Session reload 后仍保留终态。所有格同时验证 queue progress、typed
overload metadata、进程树/lease/port/browser/PTY/ACP/临时根回收与 Provider credential
absence。

Bounded foreground command handoff 固定运行 DeepSeek Flash/Pro × Headless、真实
ACP stdio + child-backed terminal、raw PTY TUI 与 production Chromium Web GUI 八格
矩阵。模型必须以 `run_in_background=false` 启动同一 host-barrier Bash；1 秒测试配置
预算到达后，durable result 和 surface 必须先发布 `auto_backgrounded=true`、typed
reason/budget 与同一 `shell_id`。子进程仍活跃时模型完成独立 Read，host 才释放
barrier；随后恰好一次 TaskOutput 获得交接前后两个 output marker。每格证明：

- 命令只启动一次，local PID 或 ACP terminal child identity 不变；
- foreground lease 原子替换为 background lease，ACP 不提前 release 或 local fallback；
- Headless typed JSONL、TUI、Web SSE/DOM 与 ACP update 均看到 handoff；
- TaskOutput 终态后 process/terminal、foreground/background lease、port、browser、
  PTY、SSE、临时根和 Provider credential 全部清零。

Fresh independent verification 资格要求主模型实际完成三个文件的非平凡实现，并在
第一次尝试结束时由 runtime 强制启动新的内置 `verification` subagent。Verifier
必须处于独立 child Session，运行项目已配置的真实测试，返回恰好一个结构化 PASS；
FAIL/PARTIAL、缺失 verdict、PASS 后继续写入或重试耗尽均不得成功完成。确定性测试
另行覆盖 backend/API/infrastructure 单文件触发、文档/fixture 排除、reserved agent、
YOLO 只读 Bash、越界 cwd/env/background/重定向拒绝和 durable mutation revision
恢复。本地 verifier 的 sandbox 还必须证明 workspace 不可写、网络关闭、user
home/Blade storage 不可读且 provider key/Session env 不进入子进程。Production Web
GUI 必须显示唯一 verification 卡片和 PASS badge、三个 changed
files 与最终 marker；清空浏览器状态并重启 server 后仍须恢复同一张卡，且页面不得
暴露内部 completion reminder 或 application console error。ACP 必须通过标准 Task
tool-call update 显示同一 verdict。

Native Read-Only Code Review 资格必须覆盖 `uncommitted`、`base` 与 `commit`
target、tracked/untracked SHA-256 digest、500 files/8 MiB 边界、精确 changed-line
校验、stale、abort、process-restart interrupted、fork/rewind 和 single-active-review。
内置 `review` 与 `verification` 共用 audit authority：写工具、后台命令、env override、
越界 cwd 和网络必须拒绝；sandbox 中 workspace 不可写、HOME/Blade storage/provider
key 不可读，同时 Git 通过隔离 config 正常读取目标。

真实 GPT 必须分别经 production Web route、ACP `/review` 与 TUI runtime hook 找出同一
授权绕过，返回 target 内的结构化 P0/P1 finding，并由宿主证明 review 前后文件 bytes
与 Git status 完全一致。Production DeepSeek GUI 必须从 Task Home“评审”模板启动，
实时显示独立运行态、只读工具进度和 completed 报告，无需手动刷新；fresh tab 还须恢复
priority、relative path、line 与 confidence。结构化 report chrome 必须支持中英文，
browser console 不得有 application error。

Hook trust 资格要求 GPT 通过 production stream 实际发出工具调用。相同的
PreToolUse command 在 `untrusted` 状态必须零副作用，只有当前 SHA-256 摘要被显式
信任后才能执行。确定性安全测试另行覆盖 `0600` 原子存储、symlink/owner/mode
fail-closed、Git worktree common root、配置变化自动进入 `modified`、跨 workspace
配置隔离、stale reviewed digest 返回 `409`，以及 managed Function hooks 不进入项目
摘要。生产 Web GUI 必须验证 review、trust、modified、re-trust、revoke、Escape
焦点恢复和 fresh-tab console。

Workspace Trust 资格必须在隔离仓库中同时放置恶意模型 endpoint、stdio MCP marker、
`permissions.allow: Bash(*)`、BASH_ENV、项目指令和带副作用的 package
`type-check` script。未信任轨迹必须过滤全部项目层，
通过用户渠道完成真实 GPT SessionRuntime 回合，并证明恶意 HTTP endpoint 请求数和
MCP/package-script marker 都为 0。信任后的本地 YOLO Session 才允许 post-edit
验证，并且只使用声明的 `type-check` script；ACP、`default`/`autoEdit`、无 script
和未信任路径必须零执行。确定性测试另行覆盖 `0700/0600` 存储、symlink/owner/mode
fail-closed、父目录继承与子目录 deny、Git worktree identity、TUI 启动 review、
Web/ACP 管理入口、验证进程取消/回收，以及
plugins/commands/skills/agents/instructions 的 discovery gate。
Production Web GUI 必须只展示 package script 名称而非命令正文，并分别在未信任
Default、已信任 Auto Edit 模式完成真实模型 Write；两者都不得产生验证 marker，
fresh tab 不得出现应用 console error。

ApplyPatch 资格不能只验证最终文件内容。确定性测试必须注入发布中途 rename failure
并证明所有 source/destination 恢复、stage/backup 归零；还要覆盖完整 grammar、
context mismatch 零副作用、symlink escape、同路径三方排队、多路径死锁、Add/Delete/
Move Snapshot 整体 rewind、Hook 任一路径匹配、LSP didClose/didSave 和 ACP 远端
ambiguous write failure 的 read-back 补偿回滚。还必须人工构造 `preparing` 与
`committed` crash journal，证明 Session startup 分别执行回滚和仅清理，并验证两个
独立调用受 0600 workspace lock 串行化。

真实 GPT 必须先 Read 两个 existing files，再只调用一次 ApplyPatch 同时更新两文件
并新增第三文件；不得退回 Edit、Write 或 Bash，且 workspace 不得残留 transaction
文件。生产 DeepSeek Web GUI 必须在 Auto Edit 本地任务中复现同一轨迹，展示三个
changed files 与每文件 diff，并在 fresh tab 保持零 application console error。

LSP 资格必须使用真实 stdio JSON-RPC 子进程，不接受纯 mock transport。确定性测试
覆盖 initialize、didOpen/didChange/didSave、publishDiagnostics、全部语义查询、
同名双 Session 进程与环境隔离、ACP 零本地进程、ContentModified 重试、request
abort、崩溃有界重启和 dispose PID 回收。项目 LSP command 必须进入 Workspace
Trust review，args/env 不得投影到 Web。

真实 GPT 必须先通过 ToolSearch 激活 deferred LSP schema，再实际调用 hover；下一
回合 Write 必须从同一连接收到 `FAKE1001` 诊断，Session 销毁后 PID 归零。生产
DeepSeek Web GUI 必须完成 Security trust、Auto Edit 本地任务、ToolSearch → LSP →
Write 诊断轨迹，并在 task 终态证明 LSP PID 已退出且 fresh tab 无 console error。

MCP Session 隔离资格使用两个均已信任的项目：进程从 project A 启动并让 Store 包含
A 的 stdio server，production SessionRuntime 则为 project B 创建。真实 GPT 回合前
必须与 B 的 MCP 完成握手，marker 只能出现在 B 的 cwd，A 的 marker 必须保持不存在。
确定性测试还要证明 builtin tools 不读取全局 MCP registry、ACP/CLI 来源优先级、
`--strict-mcp-config` 和 connecting/error 客户端回收。生产 Web GUI 必须从 Security
面板批准 B、派发真实 API task、看到目标回复，并证明 task 终态后 stdio 子进程归零。

MCP Elicitation 资格必须使用真实 stdio MCP transport，覆盖 Form、URL、
`notifications/elicitation/complete`、无交互面、非法响应、tool abort 和重叠调用。
Form 响应必须按原始 requested schema 校验，Elicitation/ElicitationResult Hook 不能
绕过 schema；事件和 Session transcript 不得保存用户填写内容。ACP 必须对无法表达的
必填自由文本或多选 fail closed。真实 GPT 必须先用 ToolSearch 激活 deferred MCP
工具，再消费只存在于 elicitation 结果中的 profile 并继续 Write。生产 DeepSeek Web
GUI 必须完成 MCP 工具审批、结构化表单、任务注意力、最终回复、fresh-tab 零应用
console error，并证明任务终态后 stdio PID 已回收。

MCP Roots/Sampling 资格必须让真实 stdio server 主动调用 `roots/list` 和
`sampling/createMessage`。确定性测试覆盖 canonical URI、worktree execution root、
ACP 空 roots、能力协商、配置上限、text/image、unsupported content、请求次数、重叠
调用和 parent abort。Sampling 默认不声明；显式 opt-in 后每次仍必须 one-shot 审批，
YOLO 不得绕过，TUI/Web/ACP 不得显示虚假的持久授权。真实 GPT 必须完成 ToolSearch →
MCP tool → nested sampling → Write；生产 DeepSeek Web GUI 必须显示请求预览和 token
上限、完成最终回复、fresh-tab 恢复，并证明 PID、端口和临时目录已回收。

MCP Call Lifecycle 资格必须用真实 stdio server 验证 progress token、顺序进度、
parent abort、idle heartbeat、hard total timeout 和 disconnect PID 回收。非法、倒退
或过量 progress 不得进入 Loop；progress 只作为瞬态 `tool_progress` 投影到
TUI/Web/headless/ACP 和 subagent，不得进入模型 transcript。真实 GPT 必须完成
ToolSearch → progressive MCP → Write；生产 DeepSeek Web GUI 必须在默认折叠工具组
直接显示进度 message 和百分比，并完成最终回复与 fresh-tab console 资格。

MCP Tool Result 资格必须用真实 stdio server 返回 text、structured content、
image/audio、resource text/blob、resource link、大文本、协议错误和超限结果。binary
不得以 base64 进入模型、Web、ACP 或 transcript；artifact 目录/文件必须分别为
0700/0600，并验证 Session hash 隔离、内容 hash、配额和 ACP 宿主路径隐藏。真实 GPT
必须完成 rich result → large result → Read private artifact → Write；生产 DeepSeek
Web GUI 必须显示 marker、size/SHA-256、artifact path 和最终回复，并证明 trace、
transcript、PID、端口和临时目录无原始 `_meta`、base64 或凭证残留。

MCP Logging 资格必须使用真实 stdio server 覆盖 `logging/setLevel`、
`notifications/message`、运行时调级、严重度过滤、nested secret/URL/token/`_meta`
脱敏、16 KiB 投影、8 KiB message、每秒 64 条限流和 Session ring。日志事件必须投影
到 TUI/headless/Web/subagent/ACP，但 provider messages 和 durable transcript 中必须
保持零 marker；ACP 只能显示 opaque hash。真实 GPT 必须完成 ToolSearch → logging
MCP → Write；生产 DeepSeek Web GUI 必须显示 warning/error 完成态诊断卡、MCP 管理
面板日志与级别按钮、最终回复，并证明 error 日志不增加 failed tool count，PID、端口、
trace、transcript 和临时目录无原始凭证残留。

MCP Server Instructions 资格必须读取真实 stdio initialize response，覆盖 NFKC、
Unicode tag/Cf/Co/Cn 清理、1 MiB source、每 server 8 KiB、每 Session 32 KiB、
JSON/XML 边界转义、
source hash、snapshot replacement 和 connection generation 撤销。伪
`</system-reminder>` 内容不能覆盖 system/user/permission/trust；ACP 只能投影
provenance hash。真实 transport 必须完成 V1 → crash/remove → V2/re-add 并回收两代
PID。真实 GPT 与生产 DeepSeek GUI 必须在用户不提供必填 code 时，仅从 scoped
instructions 得到参数并完成 MCP → Write；Web 还必须显示 instruction 完成态卡和
MCP 管理面板安全预览，trace/transcript 中不得包含隐藏 Unicode 或凭证。

MCP Completion 资格必须使用真实 stdio `completion/complete`，覆盖 capability、
prompt/resource template catalog ownership、未知 argument/context 请求前拒绝、15 秒
超时、turn cancellation、每 client 4 并发、1 MiB source、100 values、单值 4 KiB、
累计 64 KiB、NFKC、Cf/Co/Cn/tag/bidi/private-use 清理、去重和 raw SHA-256。
同名 server 必须保持 Session 隔离且回收全部 PID。真实 GPT 与 production DeepSeek
GUI 必须完成 ToolSearch → CompleteMcpArgument → scoped candidate → MCP tool → Write，
并忽略候选中的伪 system-reminder。Web 管理面板必须覆盖 prompt/resource target、
partial value、安全候选、hash、truncation 与 pending 收敛。

MCP Async Tasks 资格必须使用真实 stdio task-capable server，覆盖 capability 与
`taskSupport` catalog identity、默认 disabled、required 自动后台化、optional 默认前台
及显式 `StartMcpTask`、Session/workspace ownership、取消和 dispose cleanup。原始
server task ID、result `_meta`、Bearer 与宿主路径不得进入模型或 UI；result 必须经过
共享 MCP Tool Result 预算。故障注入必须分别中断 `tasks/get` 和 `tasks/result`，新
generation 只能在 task ID + `createdAt` 一致时恢复，全部旧 PID 必须退出。真实 GPT
与 production DeepSeek GUI 必须完成 ToolSearch → required task → opaque
`mcp_task_*` → TaskOutput → Write；Web 卡片必须从 running 原地更新为 completed，
管理面板必须显示 opt-in、Session 上限和 poll interval。

Durable Session Archive 资格必须以 JSONL 为唯一真相，覆盖直接归档、fork/subagent
继承归档、单独归档后代、恢复根后保留子归档，以及 active/archived 独立 cursor
scope。归档必须在稳定顺序获取整棵子树 Session lease；任一 queued/running 后代或
外部 owner 都要证明根 transcript 零新增。SQLite 递归 projection 与 JSONL fallback
必须逐条一致；Runtime、metadata update、Web write route 和 ACP `session/load` 均需
在副作用前拒绝归档 Session。

真实 GPT 必须完成第一回合、归档、Runtime/update 双拒绝、恢复和带 durable history
的第二回合。production DeepSeek Web GUI 必须从 Session 行 Popover 归档，证明 active
catalog 清空且 archived message 返回 HTTP 409，再从 Archive Popover 恢复并完成同一
Session 第二回合。transcript 只能出现 `archivedAt: timestamp -> null` 两次迁移，被
拒绝输入不得落盘；fresh tab 只能有正常 Session 状态日志。测试结束后 server port、
临时 storage root 和 worktree 进程必须归零。

Portable Session Markdown Export 资格必须直接读取稳定 JSONL snapshot 并应用所有
durable rewind marker；不能用当前 provider context、Web 内存或 SQLite read model
代替。确定性测试覆盖 text/image/summary/reasoning、part update、无 message parent 的
tool result、subagent/file activity、active/archived exact workspace，以及 system
recovery 内容不外泄。credential key、Bearer、private key、data URL、签名 URL、隐藏
Unicode 和 workspace 外 Unix/Windows host path 必须经过预算投影。单 activity 64 KiB、
总导出 16 MiB 和 ACP inline 1 MiB 都需 fail closed 或显式 truncation；正文 SHA-256
必须可从 `---` 后 UTF-8 字节独立复算。

TUI 必须使用 `0600` exclusive create 并证明同名文件不覆盖；ACP 不得写宿主路径；
Web 必须拒绝缺少 hash/count provenance header 的响应。真实 GPT 必须实际调用 Read
读取公开 marker、伪 API key 和宿主路径，导出保留 call/result 与 marker、隐藏敏感值，
并从 TUI 和 ACP 得到同一摘要。production DeepSeek Web GUI 必须分别从 active row、
archived Popover 和 fresh tab 下载 exact Session；HTTP 响应需为 `no-store` 安全文件名，
正文 hash 匹配，fresh tab 无 application console error。测试结束后端口、临时根和
下载验证产物必须归零。

Durable Pending Interaction 资格必须证明权限、`AskUserQuestion`、MCP Elicitation
与 Sampling 请求在 surface 可见前写入 JSONL，用户响应在解除工具阻塞前写入。确定性
测试覆盖大小预算、同 Session 单 pending、响应幂等、fork/rewind 隔离、HTTP schema、
TUI/ACP 启动顺序和 Runtime mailbox 重载。进程重启后不得自动重放原工具副作用；必须
关闭原 tool call、写入带 provenance 的恢复结果，再通过 durable inbox 启动
pending-only turn。

真实 GPT 必须从预置 pending Session 分别经 Web response、ACP `session/load` 和 TUI
Runtime hook 回答结构化问题并实际调用 `Write`。Production DeepSeek GUI 必须在 fresh
load 显示问题与 pending badge，回答后自动继续、产生精确 changed file，fresh tab 不得
再次显示问题，browser console 不得有 application error。

Web response 轨迹的完成窗口必须晚于该模型的 Provider hard/idle watchdog，不能由测试
timer 抢先把仍在运行的请求归类为 recovery failure。超时诊断必须脱敏并同时包含 Bus
terminal/stall 事件、Session task metadata、durable interaction/inbox/turn 事件、
transcript tail、目标文件和 Runtime residency；无论成功或失败都必须 shutdown route
controller，证明 active run、Provider lease 与 resident Runtime 已回收。该窗口只负责
让 runtime 先给出 authoritative terminal，不得增加 Provider 或测试重试。

Session Permission Mode 资格必须证明权限策略属于 durable Session，而非进程全局或
单一 UI Store。确定性测试覆盖 `default/autoEdit/yolo/plan`、latest update wins、
legacy fallback、fork/task 继承、非法值 fail closed、SessionStart Hook snapshot、
Plan 批准后的写前持久化、metadata 失败零执行，以及显式调用覆盖高于恢复值。Web
切换历史 Session 必须恢复对应模式，新任务必须重置为 `autoEdit`，不能从上一
`yolo` Session 泄漏。

真实 GPT 必须将进程默认设为 `default`，仅在 Session JSONL 中持久化 `yolo`，随后
分别通过不携带 mode 的 Web HTTP、ACP `session/load`、headless `--resume` 和真实
TUI activation 完成实际 Write。四条轨迹都必须产生精确文件字节；Web/ACP 不得出现
permission request，headless 不得以“需要交互确认”失败。Production Web GUI 必须
创建完全访问 Session，fresh reload 后仍显示完全访问；点击新任务后必须显示自动审批，
再返回原 Session 时恢复完全访问。浏览器 console 必须无 application error。真实 API
轨迹必须使用统一 180 秒 Provider hard timeout、零 retry，并让 surface/test terminal
窗口晚于 Provider timeout；Web failure path 必须 shutdown route controller，不能用
局部 120 秒预算抢先误判长尾响应或遗留 active run。

Session Reasoning Effort 资格必须区分 durable selection 与 Provider effective
level。确定性测试覆盖 `auto/off/minimal/low/medium/high/xhigh/max`、model
capability projection、unsupported fail closed、active-turn 拒绝、Runtime service
原子替换、metadata 失败补偿回滚、fork/retry 继承，以及 TUI/Web/ACP 的同一
Session 语义。

真实 GPT 必须经不记录 Authorization 的本地透明代理完成 `low + fast + low` 请求，
销毁 Runtime，将 durable selection 更新为 `high + standard + high` 后重建并完成
第二次请求；代理必须直接观察到两个 `reasoning_effort` 请求值。production Web GUI
必须从 Task Home 完成首轮，再从 Session Composer 完成后续轮；fresh load 必须恢复
完整消息和 Session 设置。JSONL、API request body 与 UI 三方一致，证据文件不得包含
API key。TUI Computer Use 只有在测试桥接提供真实 raw TTY 时计入通过，非 raw stdin
的 Ink 启动失败不能冒充 UI 资格。

Session Service Tier 资格必须区分 durable selection、effective tier 与 Provider
request value。确定性测试覆盖 `auto/standard/fast/flex`、模型 capability
projection、OpenAI `default/priority/flex`、Claude Fast Mode payload/beta header、
unsupported fail closed、active-turn 拒绝、model/effort/tier/verbosity/style
设置组原子替换、metadata 失败补偿回滚、fork/retry/subagent 继承，以及 TUI/Web/ACP
的同一 Session 语义。

真实 GPT 必须经不记录 Authorization 的本地透明代理完成 `low + fast + low` 请求，
销毁 Runtime 并从 durable metadata 恢复 `high + standard + high` 后完成第二次请求；
代理必须直接观察到 `priority` 与 `default` 两个 `service_tier` 值，且不能发生静默
降级。production Web GUI 必须从 Task Home 完成首轮，再从 Session Composer 完成
后续轮；fresh load 必须恢复完整消息和 Session 设置。两次 upstream 响应都必须为
`200 text/event-stream`，JSONL、request body 与 UI 三方一致，证据文件不得包含
API key。

Session Response Verbosity 资格必须区分 durable selection、Provider effective 值
与实际 request projection。确定性测试覆盖 `auto/low/medium/high`、GPT-5/Codex
capability projection、Chat `verbosity`、Responses `text.verbosity`、Codex
`textVerbosity`、payload hook 合并、unsupported 与 fallback fail closed、
active-turn 拒绝、model/effort/tier/verbosity/style 设置组原子替换、metadata
失败补偿回滚、fork/retry/subagent 继承，以及 TUI/Web/ACP 的同一 Session 语义。

真实 GPT 必须经不记录 Authorization 的本地透明代理完成 `low + fast + low` 请求，
销毁 Runtime 并从 durable metadata 恢复 `high + standard + high` 后完成第二次请求；
代理必须直接观察到 `low` 与 `high` 两个 `verbosity` 值，且不能丢失对应的
`reasoning_effort` 或 `service_tier`。production Web GUI 必须从 Task Home 完成首轮，
再从 Session Composer 完成后续轮；fresh load 必须同时恢复完整消息和
`high + standard + high`。两次 upstream 响应都必须为 `200 text/event-stream`，
JSONL、request body 与 UI 三方一致，证据文件不得包含 API key。

Session Communication Style 资格必须证明它与 Provider verbosity 正交，且不能提升
prompt 权限。确定性测试覆盖 `auto/pragmatic/friendly/explanatory`、`auto` 无注入、
受限 section 顺序与 guard、仅 style 切换零 Provider 重建、active-turn 拒绝、
model/effort/tier/verbosity/style 设置组原子持久化、metadata 失败补偿回滚、
JSONL/fork/retry、Task/Team/background/resume 继承，以及 TUI/Web/ACP 的同一
Session 语义。普通 API 不得接受任意 style prompt、文件路径或 JSON。

Trusted Custom Output Styles 还必须覆盖 user/project/plugin namespacing、Folder
Trust、active plugin policy、`.blade` 对 `.claude` 的同命名空间覆盖、symlink/path
escape、hidden Unicode、文件/单 prompt/catalog bytes 与 count 预算、SHA-256
provenance、不可变 Session snapshot、durable digest backfill/mismatch fail closed
和显式内置 style 恢复。Web/ACP catalog 只能暴露
`id/name/description/source/contentSha256`，不能暴露 prompt 或宿主路径。

真实 GPT 必须经不记录 Authorization 的本地透明代理完成 `pragmatic` 请求，销毁
Runtime 并从 durable metadata 恢复 `explanatory` 后完成第二次请求；代理必须在实际
`system` 或 `developer` message 中直接观察到对应 style section 和权限 guard。
production Web GUI 必须从 Task Home 完成首轮，再从 Session Composer 完成后续轮；
fresh load 必须恢复完整消息和 `explanatory`。两次 upstream 响应都必须为
`200 text/event-stream`，JSONL、request body 与 UI 三方一致，证据文件不得包含
API key。

custom style 的真实 GPT 与 production Web GUI 资格必须至少各完成 project 与 plugin
来源的一轮请求；透明代理直接观察对应 marker 位于受限 `communication_style`
section，Session JSONL 记录 namespaced ID 与 digest。fresh load 必须恢复 custom
selection；证据目录不得包含 style prompt 原文之外的凭证或绝对宿主路径。

MCP OAuth 资格必须使用真实 authorization server 与真实 Streamable HTTP MCP，
覆盖 RFC 9728/8414 discovery、动态 client registration、state/PKCE、code exchange、
短期 access token 的 `401` refresh、请求重放、新客户端账本恢复、logout 和 callback/
HTTP PID 回收。凭证账本必须验证 0600、原子并发、symlink/mode/schema fail closed，
endpoint/client/scopes 不能串线；普通 connect 必须零浏览器副作用，ACP/headless
不得访问宿主凭证或启动授权。真实 GPT 必须完成
ToolSearch → OAuth MCP → Write。生产 DeepSeek Web GUI 必须经过显式
Authorize/Continue authorization、刷新后的 Resume authorization、自动重连、MCP 与
Write 审批、最终 marker 和 fresh-tab 恢复，trace 中不得出现 access/refresh token。

Workspace Agent 资源隔离资格使用两个均已信任的项目，各自包含原生与 plugin
agents、skills 和 commands。确定性测试必须通过真实文件 loader 建立两个 workspace
registry，复制 Session 快照后清空基础表，并证明 Task/Skill/SlashCommand 的描述与
执行仍只包含所属项目资源。真实 GPT 必须在并发 `SessionRuntime` 与同一连接的 ACP
双 cwd Session 中分别调用对应 plugin command，marker 不能交叉；DeepSeek Flash/Pro
还必须通过生产 CLI `--agents -> Task` 完成代码修改与测试。production Web GUI 必须
绑定并信任 A/B，在独立 worktree 中分别执行对应 SlashCommand，回切后保持各自 marker，
fresh tab 无 console error。Task/Team 的 foreground、background 与 resume 均要证明
继承父 Session 快照；`projectRoot` 与执行 `workspaceRoot` 不得重新耦合。

Trusted Contextual Project Rules 资格必须覆盖 Git root 到 target 的层级、
`AGENTS.override.md` shadow、`CLAUDE.local.md`、`.claude/rules`、
`.blade/rules`、`paths` glob、Folder Trust、symlink/path escape、hidden Unicode、
文件数与 bytes 预算、Session snapshot、去重、compaction 保留和 provenance mismatch
fail closed。首次只读触达后下一次 provider request 才能出现 conditional rule；首次
写入触达必须在副作用前阻断。JSONL 只能保存 rule ID、repository-relative path 与
SHA-256，不能复制规则正文或宿主绝对路径。

真实 API 轨迹必须在首个请求后删除磁盘上的 rules，随后通过 Read 从 Session snapshot
加载匹配 marker，证明不匹配 glob 从未进入 payload，并完成受规则约束的代码修改与真实
测试。production Web GUI 必须展示 `Project Rules` 活动卡、完成真实响应和 fresh-tab
恢复；CLI/headless 与 ACP 必须输出同一安全摘要事件。

Session-owned User Shell Command 资格必须覆盖 32 KiB 输入、UTF-8 分片、ANSI 清理、
binary 降级、capture/stream 独立预算、async output 排序、exact workspace/env、
durable resume、active-turn auxiliary steering 和整棵进程树取消。TUI、Web、headless
与 ACP 必须证明 `!` 不创建 Agent；ACP terminal 不可用时必须 fail closed，不能回退
Blade host shell。

真实 GPT 必须经不记录 Authorization 的本地透明代理执行 shell、销毁 Runtime 并恢复
同一 Session；shell 阶段代理请求数必须为 0，后续真实 provider payload 必须直接包含
`<user_shell_command>` 与输出 marker。production DeepSeek Web GUI 必须从 Task Home
创建普通 Session，网络中只出现 `/shell` 而非 task/message 请求；随后普通 follow-up
通过 `/message` 使用该 marker。fresh tab 必须恢复一个 command card、两轮 durable
history、零内部 XML 和零应用 console error。TUI Computer Use 只有在自动化桥接能保持
真实 raw TTY 焦点并完整提交命令时计入通过；否则必须依赖 Ink 渲染、真实 PTY 和进程树
测试，不能把启动截图算作完整 TUI 资格。

TUI Terminal Input 资格必须覆盖普通 multi-character stdin、同一 React batch 内的
快速字符、完整和 split bracketed paste、CRLF、focus CSI、literal `[I`/`[O]`、
TTY mode 成对启停与 GracefulShutdown 复位。raw Ink 测试必须把完整输入提交给
command handler；production PTY 必须将 bracketed payload 送入刚构建的
`dist/blade.js`。

真实 DeepSeek 必须经不记录 Authorization 的透明代理直接观察完整 pasted prompt
位于 provider request body，并返回由分段 token 组成的预期 marker。Web GUI smoke
必须证明 terminal-only 改动没有影响 Composer：多字符 `!` 输入仍只走 `/shell`，
fresh tab 恢复一个 command card，内部 XML 和应用 console error 均为零。Computer
Use 只有在工具能稳定寻址独立 terminal process/window 时计入通过；bundle ID 指向旧
实例或焦点可能落入用户窗口时必须停止 UI 操作，改用 raw PTY 证据。

Production Web bundle 资格必须从 fresh build 产物计算，且构建调用者设置
`NODE_ENV=test` 时仍必须打入 production React runtime。CI 不得读取旧 `dist` 通过
预算；initial entry graph、单入口和总 JS gzip 均需在 production build 后重新验证。

Plugin Marketplace 资格必须使用隔离 HOME 和本地 Marketplace snapshot。确定性测试
覆盖 `0600` 严格账本、跨进程串行写、Git `execFile` 参数边界、显式 source trust、
symlink/路径逃逸/凭据 URL/体积限制、摘要篡改、失败更新回滚、旧根保留和依赖删除保护。
真实 GPT 轨迹由 ACP 安装 v1、Web 刷新并更新 v2，活动 Session 必须继续调用 v1，新
Session 必须调用 v2，卸载后后续 Session 不再投影命令。生产 DeepSeek GUI 必须完成
Marketplace 添加、目录选源、可信安装、真实 SlashCommand、双确认更新/卸载、依赖阻止
Marketplace 删除和 fresh-tab 零 console error。
兼容性扩展还必须证明同 Marketplace 传递依赖一次提交、循环或 Blade/semver 不兼容时
账本零变化、运行时固定点降级 dependent、反向依赖不可卸载；来源策略需覆盖 host
wildcard 边界、本地 canonical root、Marketplace identity、项目 tighten-only、
`BLADE_PLUGIN_REQUIRE_SHA` 和 checkout SHA mismatch。

Workspace 模型与 Provider 隔离资格让两个已信任项目配置相同 channel ID 和 model
config ID，但使用不同 endpoint。确定性测试在 Session 快照创建后修改项目文件和进程
全局 catalog，初始模型与 fallback 仍必须解析到各自原 endpoint。真实 GPT 资格通过
两个本地记录代理转发同一真实上游，并发 Session 必须各命中一个代理且成功完成采样；
任何请求落到另一项目或后改的故障 endpoint 都判失败。Task/Team 的前后台与 resume、
Prompt Hook、Web dispatch/message、ACP new/load/fork 都必须继承同一快照。
Production Web GUI 必须在绑定项目 A/B 之间切换，模型按钮和展开列表只显示当前项目
模型，迟到的旧 workspace `/models` 响应不得覆盖新项目，回切恢复且 console 为空。

真实 API 项目覆盖生产 CLI 轨迹，包括：

- 持久化文件回退：模型通过生产 CLI 完成 Read/Edit/Bash 后退出，宿主以同一 session 重建快照管理器，验证原路径和写后哈希仍可恢复；回退后文件内容、干净 Git 状态和测试结果必须回到基线；
- 单文件缺陷修复：读取、编辑、运行测试并确认 diff 范围；
- 多文件 API 迁移：修改所有生产调用方并运行类型检查和测试；
- 临时 CLI 设置：从启动目录加载 `--settings` 文件，在代理转发首轮请求前删除该文件，验证隐藏系统指令已经进入模型上下文，并完成 Read/Edit/Bash、独立测试和 diff 校验；
- 分层项目指令：从 Git 根到 CLI 启动目录按作用域注入 `CLAUDE.md`、`AGENTS.md` 和 `BLADE.md`，在 32 KiB 预算内优先保留深层规则；透明代理验证首轮模型请求中的来源、顺序和覆盖值，并在转发前移除规则文件，证明最终修改不依赖工具补读；
- 瞬时 API 恢复：本地代理让首个模型请求返回 `503`，随后转发真实 API，CLI 必须在零输出边界内重试并完成代码修改与测试；
- 上下文超限恢复：本地代理让首个模型请求返回 `413 context_length_exceeded`，随后
  透明转发真实摘要与恢复请求；Headless 必须完成 paired compaction lifecycle、持久化
  replacement checkpoint，并由第二个 Runtime 仅依赖该 checkpoint 回答此前 marker；
- 工具崩溃恢复：真实 DeepSeek 先通过生产 Headless 执行 Write，在外部文件副作用已发生
  后注入 `tool_result` fsync 失败；当前 run 必须在发布 result 和第二次 Provider 请求前
  fail closed。第二个 Runtime 必须为已终止 turn 的 orphan 写入
  `sideEffectsUncertain` receipt，真实模型 resume 只能读取并确认既有文件，不得再次调用
  Write/Edit；
- 根回合自动恢复：持久化原始 inbox message、未闭合 Write 和已落盘 marker 后释放
  Session owner；新 Runtime 必须先提交 restart receipt，再从 canonical JSONL model
  projection 恢复原输入。Headless bare `--resume`、TUI `--resume` 和 Web GUI SSE
  reconnect 均只能执行一次 Read，Write/receipt/Read 各恰好一次，GUI reload 后结果仍
  可见且浏览器无 application/network error。最终 token 不得完整出现在恢复 prompt 或
  Read 结果中；PTY 终态必须由精确 inbox acknowledgement 与对应 `turn_completed`
  共同证明；
- 响应提交恢复：真实 DeepSeek 产生最终文本后注入 assistant message fsync 失败；临时
  content delta 可以被观察，但当前 turn 必须 aborted、不得提交 assistant 或
  `turn_completed`。冷启动由 wake-up 输入触发后必须优先重新执行原 durable inbox，
  第二次真实响应成功提交且不泄露底层 I/O 错误；
- turn finalization 恢复：真实 DeepSeek 的最终 assistant 与 final receipt 已提交后，在
  inbox ack/terminal 前注入进程退出；冷启动必须先原子补
  `inbox_acknowledged + turn_completed` 并重载 sidecar，随后只处理新输入。旧输入不得
  再次请求 Provider，最终历史必须有两个 completed、零 aborted turn；
- Goal finalization handoff：最终 assistant 的 host receipt 已提交、Goal sidecar 仍为
  `verifying/pass` 时退出。新 Runtime 必须用 exact goal ID、attempt、verifier Session、
  evidence digest 与 revision 幂等补 `complete`；Headless 回放、raw PTY、production
  Web GUI 和 ACP `session/load` 均不得为旧 Goal 发起 Provider 请求。随后同一入口发送
  新 prompt 并通过透明代理完成真实 Flash/Pro 响应，证明恢复后仍可继续工作；
- Goal verification attempt 是单调递增的恢复序号，不是固定值。FAIL/PARTIAL、格式纠正
  或 evidence 失效后可进入 attempt 2 及后续 attempt；release trajectory 必须要求最终
  Goal 为 `complete`，且当前 attempt 具有 fresh `PASS`、verifier Session ID 和
  SHA-256 evidence，但不得把合法的正整数 attempt 锁死为 `1`；
- 计划模式恢复：跨两个 CLI 进程恢复会话并完成修改；
- 模式边界恢复：在 Yolo 中故意调用一次 ExitPlanMode，运行时必须返回 `validation_error`，模型随后继续 Write/Bash，证明过期规划状态不能终止已经批准的工作；
- 失败恢复：先重现测试失败，再修改，最后验证通过；
- 超时恢复：回收完整进程树后继续工具循环，并确认没有后代进程遗留；
- 后台 shell 硬崩溃恢复：独立 Blade owner 启动 TERM-ignoring detached process group 并
  在 dispose 前硬退出；新 Runtime 必须通过 durable lease 与启动身份回收旧树，PID
  复用/身份不匹配及 TERM grace period 内的 ownership 变化不得误杀，损坏 lease 必须
  fail closed，lease 提交失败时 gate wrapper 不得执行用户命令，sidecar 不得包含命令、
  环境、输出或凭据；
- 前台 shell 硬崩溃恢复：真实 DeepSeek 必须分别从 parent 和 subagent 发起含延迟写入的
  foreground Bash；宿主在 tool result 前 `SIGKILL` 独立 Blade owner，新 Runtime 取得
  parent/child Session lease 后必须先回收对应 foreground tree，再闭合 orphan Bash tool
  receipt。延迟文件不得出现，lease commit/gate release 失败必须零执行，PID identity
  mismatch 不得误杀，损坏 sidecar 必须阻断恢复，sidecar 与 CLI 输出不得包含命令、
  环境、输出或 API key。Subagent 对照不得依赖固定 sleep：TERM-ignoring descendant
  必须等待 host gate，host 只在 root PID 退出且 durable lease 删除后开放 gate；若进程树
  有任何残留，forbidden side effect 必须确定性出现并使资格失败；
- leaderless process group：parent 真实 API 轨迹必须先证明 shell/gate root PID 已退出、
  TERM-ignoring 后代仍存活，再硬杀 Blade owner。Linux/macOS reaper 必须独立探测负
  PGID 并在延迟副作用前完成 TERM/KILL；root PID 在 grace 中复用时禁止 KILL 并保留
  lease。正常 foreground/background/ACP local close 也要验证全重定向后代在 terminal
  result 前回收；Windows 继续验证 live-root `taskkill /T`，不宣称 POSIX PGID 语义；
- session 退出回收：模型启动后台进程后正常结束 CLI，验证 runtime dispose 等待整棵进程树终止；
- 中断恢复：真实信号中断活动工具调用，持久化一次模型可见的中断边界，再由第二个 CLI 安全恢复；
- session 独占：活动 runtime 拒绝第二个同 session CLI 且不持久化其输入，owner 退出后允许恢复并继续验证；
- transcript 截断恢复：在 session JSONL 尾部制造未提交半行，恢复后完成 Write/Bash 任务，并逐行验证修复后的完整历史；
- 上下文压缩续跑：受限上下文窗口在 Read 后触发一次自动压缩；透明代理暂停真实摘要请求时，stdout 必须已实时发出 `compacting: started`，随后保持纯 JSONL、落盘自动摘要，并在 `compacting: completed` 之后执行 Write；
- Web surface：通过生产 HTTP session 路由提交任务并消费真实 SSE，验证代码修改、宿主测试、canonical tool success，以及 `compaction.started` / `compaction.completed` 在 resumed Write 之前按序可见；
- 结构化用户问题：Web 在 `yolo` 中仍必须发出 `question.required`，SSE 断线重连只重放当前未解决且 ID 不变的问题，提交结构化答案后继续 Write/Bash；ACP 在自动批准模式下也必须通过标准 permission options 收集单选答案。ACP 协议无法保真表达多选时 fail closed，不得静默降级为单选；
- 阻塞交互取消：TUI 先结算所有 confirmation 再中止回合；Web abort 必须使 pending permission/question 立即失效，并等待旧回合释放 runtime 后才返回 idle，晚到回答返回 `404`；ACP cancel notification 必须独立打断未响应的 reverse request。Flash 和 Pro 都要在同一 session 中取消问题后继续完成 Write/Bash，且 cancelled 终态不得被 completed/error 覆盖；
- 权限作用域：`once`、`session`、`project` 必须是不同契约。TUI/Web 显式展示会话级与项目级选择；session approval 只进入当前 runtime cache，不能写盘，并在同一 runtime 的第二个独立 turn 复用、在新 session 重新询问；project approval 写入目标 workspace 的 `.blade/settings.local.json`，不能落到 server 启动目录或泄漏到其他项目，新 Web/ACP session 必须自动加载。ACP `allow_always` / `reject_always` 映射为真实项目级持久规则；Flash 和 Pro 都通过真实 Bash 轨迹验证；
- 交互式后台 Shell：`WriteStdin` 只能操作当前 session 拥有的后台 Bash，等待写入完成并可显式关闭 stdin；跨 session、已退出进程和缺失 session 必须 fail closed。TUI、Web、ACP 中的 Flash 和 Pro 都要完成 `Bash(background) -> WriteStdin(close) -> TaskOutput(block)`，并由宿主验证实际文件和三个工具事件；
- 有界后台输出：后台 Bash 的 stdout/stderr 各自超过 1 MiB 后只能保留最近输出并精确报告更早省略字节数；TUI、Web、ACP 中的 Flash 和 Pro 都要完成 `Bash(background) -> TaskOutput(block) -> Write`，验证尾部标记、`output_truncated`、stream 省略字节数、共享展示摘要和宿主证明文件；
- 有界前台输出：宿主预写脚本向 stdout/stderr 各输出 `1 MiB + 64 KiB`，每流最初
  4 KiB 内放 omitted-prefix sentinel，末尾放独立 nonce tail。Flash/Pro 必须在
  Headless、Chromium Web、raw PTY TUI、ACP SDK 四入口各只调用一次 foreground Bash。
  Headless 首次 stdout/stderr write 返回 `false` 并延迟 drain，期间不得出现第二次
  raw write；ACP 每次 update 延迟且最大 in-flight 必须为 1；PTY host 暂停 reader 后
  必须恢复最终输出；Web 必须运行中 reload、cursor reconnect 并在 fresh terminal load
  保留同一 tool card。Web/PTY 验证双流 total/retained/omitted；ACP 验证 merged
  stdout、zero stderr 和 `terminal_output_merged=true`。所有入口都必须保留双 tail、
  隐藏双 sentinel 与 API key，并清零 Chromium/page/SSE、PTY、ACP terminal、
  process identity、foreground lease、port 和临时根。虚拟列表重挂载 completed card 时，
  Web 必须原子取得 durable `toolCallId`，在 tool group 回到折叠态时重新展开并触发真实
  click handler，再断言 `aria-expanded=true` 和有界输出，不得把 card/toggle 两次
  locator await 之间的重挂载或布局 actionability 抖动当成 runtime failure。
  Goal finalization fresh-load 必须在完整有界 qualification budget 内同时验证 persisted
  Goal `complete` 与 DOM `complete`，失败时报告两侧状态及 browser faults，不能用更短的
  hydration 子截止点替代端到端预算。
  foreground gate-release failure 对照必须在释放前订阅 stdout，并在观察到超过 retained
  budget 的实际字节后注入错误，不得用固定 sleep 假设输出已经到达。raw PTY 的正向
  marker evidence 必须单调锁存；resize 或后续 redraw 只能增加证据，不能从 bounded tail
  撤销已观察事实。source contract 精确枚举 `backgroundSubagentCompletion`、
  `foregroundBoundedOutput`、`foregroundCommandHandoff`、
  `foregroundProviderRecovery`、`goalFinalization`、`gracefulShutdown`、
  `rootTurnAutoResume`、`sessionRuntimeResidency`、`subagentResultAdoption`、
  `toolAdmission`、`tui`、`weightedProviderAdmission` 12 个 PTY runner；新增 runner
  必须更新 inventory 并显式完成 marker-latching 审计。只有明确要求 resize 后仍可见的
  事实才能由 resize 后的新 PTY 数据重新证明，不能复用历史匹配。background completion
  的 Provider queue、child marker 与 parent final 必须消费同一个有界 evidence
  deadline，不能用更短的首阶段截止点误判慢首响应。Computer Use 仅在宿主
  提供稳定桌面桥接时作为补充视觉证据，不能替代自动 raw PTY 与协议断言；
- 跨表面 session branch：TUI `/branch` 原子切换到持久化子会话；Web 通过 HTTP fork 路由创建并选中子会话，活动回合返回 `409`；ACP `/branch` 返回可由标准 `session/load` 加载的子会话 ID。Flash 和 Pro 都必须在删除原 marker 后，仅依赖继承的 Read 结果继续 Write/Bash，并证明父 transcript 未改变；
- durable turn rewind：Flash 和 Pro 都必须先通过真实模型 Read/Edit/Read 产生文件
  checkpoint，再分别从 Runtime、TUI hook、Web HTTP/SSE 和 ACP `/rewind` 入口恢复。
  Runtime/TUI/Web 验证代码回到 baseline、有效 conversation 被移除且 JSONL 保留
  `session_rewound`；ACP 验证 conversation-only rewind 后重建 Agent，后续 prompt
  只使用投影历史。Web 还必须通过真实浏览器验证按钮禁用态、checkpoint 对话框、
  code restore 开关、提交后的消息列表和磁盘效果。实际结果记录在
  [durable rewind 证据账本](./durable-rewind-evidence.md)；
- TUI runtime 生命周期：通过 `useAgent` 完成真实模型回合后清理，并用同一 session ID 重新获取 runtime lease，证明退出路径释放 Agent、后台资源和会话所有权；
- ACP session/load：通过真实 ACP SDK NDJSON 连接新建并销毁会话，删除原始 marker 文件后加载持久化历史，在响应前回放用户/助手消息，并仅依赖恢复上下文继续 Write/Bash；客户端传入的 MCP server 使用会话私有注册表，初始化失败或退出时独立回收；
- ACP 会话模型切换：会话以 Flash 初始化后通过真实 `session/set_model` 切换到 Pro，透明代理必须只观察到 Pro 的后续采样请求；切换期间原子更新 provider 与上下文窗口、回收旧 provider，并完成 Read、源码修改、Bash、独立测试与 Git diff 校验；
- 单次运行 Subagent：通过 `--agents` 注入只存在于子代理系统提示中的模型专属规则，主代理仅开放 Task；Flash 和 Pro 都必须委派到自定义代理，完成 Read/Edit/Bash、独立测试、精确文件范围和纯 JSONL 校验；
- durable Subagent resume：Flash 和 Pro 都必须先由真实 Task 产生只存在于 child
  transcript 的上下文，再从 Runtime、TUI、Web 和 ACP 四个入口恢复。follow-up prompt
  不得包含目标值；child 必须只依赖恢复历史给出正确结果，并证明 source sidecar 不变、
  child ID 新建、lineage 深度递增、冻结模型/权限生效及无密钥泄漏。Web 还要通过真实
  浏览器验证 depth 1 → 2、刷新后 2 → 3、禁用态和零 console error。实际结果记录在
  [durable subagent resume 证据账本](./durable-subagent-resume-evidence.md)；
- durable Subagent crash recovery：真实 child Provider stream 在首个 content delta 后
  由透明代理保持，宿主 SIGKILL Blade owner；第二 Runtime 必须先闭合 child turn/tool
  receipt 并从 JSONL 重建 sidecar history，再以新 immutable child ID resume。follow-up
  不得包含原 token，恢复失败不得允许 Web/ACP 发起虚假 resume；
- durable completed-Subagent result adoption：Flash 和 Pro 都必须先通过真实 foreground
  Task 生成只存在于 child 结果中的 marker，再保留 active parent turn、durable inbox 与
  orphan parent Task call，并在 parent `tool_result` 提交前释放 Runtime。Headless、raw
  PTY TUI、production Chromium Web GUI 和 ACP `session/load` 必须从同一 child sidecar
  采用结果，不得再次启动 child。每格验证 resumed Provider request 含 child-only marker、
  adopted result/parent abort/inbox ACK/parent final 各一次、child sidecar 字节不变、
  compound owner 与 lineage 唯一、`sideEffectsUncertain=false`、Web live/reload 可见、
  进程/端口/临时根清理及凭据不泄漏；
- durable background-Subagent completion wake-up：Flash 和 Pro 都必须由真实 parent
  调用 `Task(run_in_background=true)`，Task 返回 running 后 parent 继续独立 Read，且
  全程零 `TaskOutput`。child 通过 Read 取得 parent input 中不存在的 marker；terminal
  sidecar、hidden canonical receipt 与 durable inbox 必须自动唤醒 parent。Headless、
  raw PTY TUI、production Chromium Web GUI 与 ACP `session/load` 每格验证 terminal
  ref/inbox ACK/parent final、child 与 lineage 唯一、sidecar 字节稳定、无伪用户消息、
  Web live/reload 一致及资源/凭据清理；
- 输出协议、工具调用、错误事件和 key 泄漏检查。

### Durable Subagent resume 轨迹

该能力必须覆盖相同的 immutable lineage 契约：

1. **Runtime**：foreground root 先持久化完整 ChatContext，销毁并重建 manager/runtime
   后恢复为 child，再恢复为 grandchild。每条边使用新 ID，源 sidecar 字节和终态不变，
   `rootAgentId` 稳定，`resumeDepth` 单调递增。
2. **CLI/TUI**：真实 `useAgent` owner 通过 `/tasks resume` 继续已结束 agent，更新
   subagent progress，但不释放 parent Runtime。退出后必须正常释放 Runtime lease。
3. **Web**：通过 exact `sessionId + projectPath` 的 GET/POST routes 和 SSE 发布
   `subagent.start/update/tool/complete`。消息卡片支持 follow-up、running polling、
   recoverable error 和刷新重建；不得把 ancestor 误选为最新 descendant。
4. **ACP**：通过真实 ACP SDK lifecycle 执行 `/tasks resume`，使用标准 `tool_call`
   和 `tool_call_update` 暴露新 child ID、状态和结果。不得用私有文本事件代替工具协议。

sidecar 必须使用原子写、`fsync`、`0600` 文件权限和 `0700` 目录权限。公共 Web
schema 只返回状态、lineage、结果与统计，不得返回 prompt、messages、配置快照、
workspace、owner PID 或 provider credential。跨 workspace、类型冲突、running source、
active parent turn 和 durable pending input 都必须 fail closed。

required matrix 固定包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`。每个模型都要通过
Runtime、TUI、Web、ACP 四条真实产品入口；worktree resume 另行验证新的 child ID
继续使用源 lease owner 并保留失败或有改动的 worktree。

### Durable completed-Subagent result adoption 轨迹

该能力验证 child terminal 与 parent Task result 之间的跨存储 commit gap：

1. fixture 必须先通过真实 Provider 运行 foreground Task，并要求模型生成不在 parent
   input 中出现的 child marker；随后只持久化 parent `tool_call`，不提交 result。
2. Runtime 只能从 exact compound owner 的 durable sidecar 采用
   `completed`/`failed` 结果；child ID、description、显式 type、resume lineage、状态或
   有界结果任一不匹配时必须回退通用 uncertain receipt。
3. 采用批次必须按原 tool-call/message identity 写入一个 `tool_result`、一个 terminal
   `subtask_ref` 和一个 `turn_aborted(process_restart)`；第二次启动不能重复写入。
4. Headless、raw PTY TUI、production Chromium Web GUI 与 ACP `session/load` 必须消费
   标准 LoopEvent。Web 还要以 durable child Session ID 定位原 card，验证 live terminal
   summary、parent final、reload 后同一状态和零 browser fault。
5. 每个 surface 的 resumed Provider request 都必须包含 child-only marker；child sidecar
   字节、child 数量与 lineage 保持不变，证明没有重复执行 Task。

required matrix 固定包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`，四个 surface 共八格。
该轨迹属于 release-blocking real API qualification，不得由 mock、HTTP 200、仅 JSONL
检查或刷新后偶然可见替代。

### Durable background-Subagent completion wake-up 轨迹

该能力验证 background Task 不依赖模型轮询即可推动长任务：

1. parent input 只能包含 marker 文件名，不能包含 child marker。真实 parent 必须先调用
   一次 `Task(run_in_background=true)`，收到 running result 后再完成一次独立 Read；
   parent transcript 中 `TaskOutput` 调用数必须为零。
2. child 必须使用真实 Provider 和 Read 工具取得 marker 并提交 terminal sidecar。
   Runtime 只接受 exact compound owner、`background=true`、canonical child ID、
   type/description/resume lineage 与结构有效的 bounded terminal result。
3. parent 必须按 `child sidecar fsync → hidden receipt + terminal subtask_ref →
   durable inbox → model consumption → inbox ACK` 顺序收敛。deterministic inbox ID、
   receipt、terminal ref、ACK 和 child lineage 都必须恰好一次；冷启动不得重复通知。
4. Headless 必须在 child 运行期间保持 Agent stream；raw PTY TUI、Web 与 ACP 必须自动
   继续 parent，不能要求人工输入。ACP 不得生成 marker `user_message_chunk`；TUI/Web
   不能渲染伪用户消息。
5. production Chromium Web 必须验证 live terminal card、parent final、reload 后相同
   child ID/status/summary、terminal sidecar 字节不变和零 browser fault。streaming Task
   必须在持久化前获得 canonical child ID；child 早完成时，迟到 running result 不能
   降级 live 或 fresh-load card。

required matrix 固定包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`，四个 surface 共八格。
测试结束必须回收 browser/page/SSE、PTY、ACP connection、server/process tree、port、
临时 storage/workspace/trust root，并证明 API key 不进入 JSONL、sidecar、DOM、PTY、
ACP update、diagnostics 或录制的 Provider body。

### Bounded coordinated shutdown 轨迹

该能力验证正常进程关闭不会把 active turn 留给下次冷启动修复：

1. 每格必须先通过真实 Provider 调用一次真实 foreground Bash；host 只能在 child PID
   文件存在且进程仍活跃后发送对应 production `SIGTERM`。
2. Agent/Session owner 必须先关闭新工作入口，再中止 active Provider/tool path，等待
   一个 `turn_aborted(cause="cancelled")` 提交后释放 Runtime、Session lease 与 transport。
   active tool 的 `shouldExitLoop` 不得抢先绕过 abort terminal；同一 interrupted turn
   不得出现 `turn_completed` 或第二个 terminal record。
3. foreground child 必须忽略 TERM 并安排延迟 forbidden side effect；shutdown 必须
   回收完整进程树和 durable lease，等待对照窗口后 forbidden 文件仍不存在。
4. 原 durable input 必须保持可恢复。同 Session 的 production Headless resume 不得再次
   调用 Bash；透明代理必须观察 exactly-one resume request，且该请求直接包含完整
   `<turn_aborted>` system marker 与原请求 marker，随后产生非空 final 并新增一个
   `turn_completed`。不得把模型是否逐字复述 marker 当成 runtime 是否恢复该 marker
   的唯一证据。
5. Headless、真实 ACP stdio + terminal、raw PTY TUI 与 production Chromium Web GUI
   分别从独立进程进入。Web 必须通过真实 composer 提交；关闭 viewer 不能等同于 server
   shutdown。每格回收 browser/page、PTY、ACP connection、server、port、process tree、
   Session lease、临时 storage/workspace/trust root，并全量扫描 credential absence。

required matrix 固定包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`，四个 surface 共八格。
该轨迹属于 release-blocking real API qualification，不得以 mock signal、直接调用
`SessionRuntime.dispose()`、仅检查进程退出码或 cold `process_restart` 修复替代。

### Session discovery 与 durable fork 轨迹

Session discovery 与 durable fork 的准出必须覆盖四个相互独立的 production entrypoint：
一个内部 Runtime boundary，以及 CLI/TUI、Web、ACP 三个用户可见 integration surface。
每条轨迹都必须从对应 entrypoint 进入，不得以直接调用模型或只验证代理请求代替产品
边界：

1. **Runtime**：通过真实 `SessionRuntime`、`Agent` 和 public
   `SessionService.forkSession()` 创建 child。parent 先执行 Read，child 仅依赖继承的
   Read 结果执行 Write/Bash。证据包括精确文件效果、parent JSONL 字节不变、parent/root
   lineage、child 独立追加、runtime 清理和 evidence 中无 secret。
2. **CLI/TUI**：通过真实 `useCommandHandler.executeCommand()` 执行初始 prompt、
   `/fork <sessionId>` 和 child prompt。证据包括 slash-command routing、child activation、
   精确文件效果、parent transcript 不变、lineage、active turn 对 `/fork` 的拒绝语义以及
   evidence 中无 secret。
3. **Web**：通过 production HTTP session routes 和 SSE 完成；deterministic Web tests
   另行覆盖 Sidebar action 与 store activation。
   - completed parent：fork 后 child SSE ready 并以 `sessionId + projectPath` 激活，child
     仅依赖继承历史产生精确文件效果；parent JSONL 保持不变且 lineage 正确。
   - active parent：在真实 provider request 保持 active 时 fork 已提交的稳定 JSONL
     prefix；parent 不被取消并继续追加，child 不包含边界后的 parent 内容且独立运行。
   两个子项都检查 compound workspace identity、结构化 HTTP/SSE evidence、资源清理和
   secret absence。
4. **ACP**：通过真实 ACP SDK NDJSON codec 和 dispatcher 执行 `session/list`、
   `session/fork`，随后直接向返回的 child prompt，不调用 `session/load`，也不 replay
   history。证据包括 discovery metadata、精确文件效果、parent immutability、lineage、
   child 独立追加、session 清理和 evidence 中无 secret。

该组轨迹的 required matrix 固定包含 DeepSeek Flash 和 Pro。若显式配置 Claude、GPT
或 domestic provider，其配置模型也必须运行四个 production entrypoint；缺少 required
Flash/Pro 时 fail closed。API key 只能从受限本机存储投影到子进程凭据槽，不写入项目
配置、命令记录、日志、快照或原始请求头。实际命令、模型集合、退出码和复跑事实记录在
[session discovery 与 durable fork 证据账本](./session-discovery-fork-evidence.md)。

仅收到模型文本或 HTTP 200 不算通过。每条轨迹都必须证明预期的文件或持久化
副作用、结构化事件和进程退出状态；涉及代码修改的轨迹还必须记录
`git diff --name-only` 以及测试或类型检查退出码。session fork 轨迹改为验证 parent/child
JSONL、lineage、精确 fixture 文件内容和资源清理，不虚构 Git diff 证据。

## 准出证据

每个独立 patch 至少保留以下证据：

- 已冻结的 Qualified candidate 完整 SHA、patch 版本和日期；
- `bun run qualify:local` 的完整命令和退出码；
- `bun run qualify:production` 的完整命令、该 patch 所需 Flash/Pro × production
  surface 矩阵逐项结果和退出码；
- browser preflight、process/lease/terminal/port/temp-root cleanup、omitted sentinel 与
  credential absence 的宿主断言；
- 失败时记录首个失败 cell、redacted bounded tail、清理结果和复跑事实；只有 source
  未变化的 Provider transient 才能整套重跑，不得用跳过测试替代通过；
- `git diff --check`、build、type-check、lint 的命令与退出码；
- evidence 只能在候选代码冻结并通过真实资格后创建。候选 SHA 到 tag HEAD 的唯一差异
  必须是完整 evidence 文件；文件不得包含 `TBD`、`TODO`、`NOT RUN` 或预填 `PASS`。

真实 API 门禁会产生费用，因此不会被 `test:all` 或普通 CI 单元门禁隐式触发；发布候选、跨 provider 改动和 Agent runtime 核心改动必须显式运行。

当前生产准出覆盖桌面 TUI、CLI/headless、Web 和 ACP。移动端没有明确使用场景，暂不纳入实现与测试范围。
