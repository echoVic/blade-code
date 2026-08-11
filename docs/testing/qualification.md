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
11. Web 测试
12. Web 类型检查
13. 当前源码构建
14. 性能回归

每一步都在独立子进程中执行。第一步非零退出会立即停止，后续步骤不会被计为通过。该门禁不访问付费模型，也不依赖 `~/.blade/config.json`。

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
bun run qualify:production
```

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

required matrix 固定包含 DeepSeek Flash 和 Pro。显式配置的 Claude、GPT 和 domestic
模型还必须通过基础 chat、streaming、usage、finish、tool calling，以及
Runtime、TUI、Web、ACP 四条 production entrypoint。仅收到文本或 HTTP `200` 不算通过。
跨端 fork 轨迹必须让 pi-ai 从自定义渠道解析凭据，不得通过模型级 `apiKey` 参数旁路。
渠道健康资格还会分别从 Web route、TUI `/doctor` 和 ACP callback 对 GPT、domestic、
Claude 发送最多 8 tokens 的真实 probe；结果必须使用 canonical failure 投影且不得
包含模型原文、原始错误或 API key。

工具并发资格要求 GPT 在同一个 production stream 中同时调用两个已加载工具。两个
工具在执行函数内互相等待，只有都进入 shared gate 才能释放；因此单纯缩短总耗时或
顺序执行无法通过。确定性测试另行覆盖 exclusive FIFO、同路径文件锁、abort、fallback
epoch、Web 多卡刷新重建、TUI keyed progress 和 ACP 独立 tool-call ID。

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
再返回原 Session 时恢复完全访问。浏览器 console 必须无 application error。

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
- 计划模式恢复：跨两个 CLI 进程恢复会话并完成修改；
- 模式边界恢复：在 Yolo 中故意调用一次 ExitPlanMode，运行时必须返回 `validation_error`，模型随后继续 Write/Bash，证明过期规划状态不能终止已经批准的工作；
- 失败恢复：先重现测试失败，再修改，最后验证通过；
- 超时恢复：回收完整进程树后继续工具循环，并确认没有后代进程遗留；
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

- `bun run qualify:local` 的完整命令和退出码；
- `bun run qualify:production` 的完整命令、使用的模型集合和退出码；
- 真实 API 运行中不得记录原始密钥；
- 失败时记录首个失败门禁和可复现命令，不得用跳过测试替代通过；
- 代码、文档和测试改动通过 `git diff --check`。

真实 API 门禁会产生费用，因此不会被 `test:all` 或普通 CI 单元门禁隐式触发；发布候选、跨 provider 改动和 Agent runtime 核心改动必须显式运行。

当前生产准出覆盖桌面 TUI、CLI/headless、Web 和 ACP。移动端没有明确使用场景，暂不纳入实现与测试范围。
