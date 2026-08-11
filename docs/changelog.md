# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### ✨ 新功能

- Goal `complete` 改为宿主权威的两阶段状态机：模型调用 `UpdateGoal complete`
  只提交 durable `verifying` 候选，保留的只读 `goal-verification` child Session
  必须返回宿主 JSON Schema 校验后的 fresh PASS，GoalStore 才会原子写入 `complete`
- Goal completion evidence 持久化 attempt、稳定 verdict、opaque verifier Session ID、
  安全摘要与 SHA-256；CLI JSONL、TUI、Web 与 ACP `_meta` 使用同一 canonical 投影

### 🐛 问题修复

- 修复执行 Agent 可在独立完成门禁前提前持久化 Goal complete 的一致性缺陷；
  FAIL/PARTIAL、mutation、steering、Stop continuation 与 process restart 均会使旧证据
  失效，模型改为 blocked 时取消完成候选
- Goal verifier 使用不可覆盖的专用只读 agent 与 schema-constrained verdict；宿主强制
  规范 Task type/background/resume/isolation，避免模型参数绕过或错误类型导致无限拒绝
- 修复长生命周期进程切换隔离 storage root 后，subagent sidecar 单例仍写入已删除旧目录
  的问题；cache 按 root 隔离，写前自动恢复私有 sessions 目录
- ACP 测试客户端实现真实 SDK terminal handle，测试命令按 cwd/env 执行，不再用固定
  “Executed” 文本伪造成功

### ✅ 测试相关

- 新增 GoalStore authority、fresh verdict、bounded retry、mutation/steering/restart
  invalidation、read-only sandbox、Headless JSONL、ACP `_meta`、Web evidence card 与
  release-matrix 回归；CLI Unit 2630、Integration 133、CLI 8、Web 385 均通过
- DeepSeek Flash 真实 API 在 Runtime、Web REST/SSE、ACP slash 三入口完成
  `active → verifying → goal-verification PASS → complete`，3/3 通过
- 固定 release-blocking real matrix 通过 20/20；22 条开放式多文件、compaction、
  进程树与 crash-recovery 长轨迹显式保留在完整付费 soak
- Production Web GUI 验证 live verifier、最终 PASS/Session/SHA 证据、fresh tab
  恢复和中英文切换；fresh tab console 无应用错误

## [0.10.9] - 2026-08-11

### ✨ 新功能

- 新增持久化定时任务调度器，支持 cron（5 段标准表达式 + 时区）、interval（最小 1 分钟）
  和 one-shot（ISO 时间点，单次执行后自动停用）三种触发模式
- `blade serve` 内置 TaskScheduler：30 秒 tick、同 schedule 重叠防护、离线 misfire 只补
  跑一次、手动运行不扰动 recurring 周期、终态由 Bus `task.status` 回写
- CLI `blade schedule` 命令组：create / list / show / remove / enable / disable / run，
  支持 `--cron`、`--every`、`--at` 快捷语法和 `--project-path` / `--model` 等分发选项
- Web Settings 新增 Scheduled Tasks 内联面板，提供 cron/interval/once 分段切换、
  自定义 Select（模型/权限/隔离）、创建/编辑/启停/删除/手动运行、二次确认和状态显示
- ACP `/schedule` slash command 提供 list/create/remove/enable/disable/run，自动纳入
  `available_commands_update`，支持 cron 表达式空格重组和 `--` prompt 分隔
- HTTP API（GET/POST/PATCH/DELETE `/schedules`、`/schedules/:id/enable|disable|run`）
  与 SSE `schedule.fired` 事件（安全投影，不泄漏 prompt）
- 持久化 `~/.blade/schedules.json`：write-file-atomic、权限 0600、串行写链、损坏行隔离

### 🐛 问题修复

- 修复 Web Schedule 面板模型字段误用原生 `<select>`，统一为项目自定义 Select 组件
- 修复 Web ScheduleStore 中重复调用 DELETE 的问题
- 修复 CLI schedule 命令 `-p` alias 与全局 `--print` 冲突导致 project 回退 cwd

### ✅ 测试相关

- 新增 schedule-timing（cron parser、timezone、Sunday 7、interval、once、过期）、
  task-scheduler（dispatch、one-shot disable、manual nextRun、terminal status）、
  schedule-routes（HTTP CRUD、run）、schedule-store（持久化、并发、malformed）、
  schedule-command（ACP slash bridge、registry）、Web ScheduleStore（CRUD + delete once）
  等单元测试
- 真实 API 验证：one-shot `c0yYIF-X20` 完成后自动停用、recurring `RIDO0KQBrp` 手动运行
  保持原 nextRunAt；两个 Session 均通过 DeepSeek V4 Flash 返回预期文本
- Web GUI 浏览器验证：Settings > Scheduled Tasks 面板中英文、创建 2h 任务、停用/启用/
  编辑/删除、自定义 Select（模型列表 + Use current model）均通过

## [0.10.8] - 2026-08-11

### ✨ 新功能

- 新增 turn-scoped JSON Schema 最终输出契约：每轮按需注入保留的
  `StructuredOutput` 工具，支持 provider constrained sampling，并由宿主 AJV
  统一校验、限制 schema/output 复杂度、执行最多两次纠正重试
- structured payload、schema digest 与 durable inbox/Task dispatch 一并持久化；
  provider tool result 和 canonical assistant message 覆盖两个崩溃窗口，重启后
  不重复采样已完成结果，后续 steering、写操作或新回合会使旧 payload 失效
- Print/Headless 支持 `--json-schema` 与 `--output-schema`，提供 text、JSON、
  stream-json/JSONL 稳定投影；Web API/SSE、ACP `_meta` 和 TUI 复用同一 canonical
  object，不从 prose 猜测或修复结果
- Web composer 新增持久化 JSON Schema 编辑器，完成结果以带 digest 和复制操作的
 结构化报告展示；live Task 即使错过初始 `message.created` 也无需刷新即可渲染，
  fresh tab 可从 durable history 恢复相同对象
- MCP 与 Skills 管理从独立浮层收口到全页 Settings 内联面板；补齐 MCP、Skills、
  rewind、subagent resume、设置错误与代码复制等中英文文案

### 🐛 问题修复

- reserved `StructuredOutput` 工具不再出现在 Web/ACP/TUI 的工具卡片或历史命令中，
 但仍保留完整模型历史和 crash recovery 证据
- schema 在 durable prepare 前 fail closed；Task retry 继承原契约，活动回合禁止
  临时切换 schema，shell/slash/review 等不兼容入口给出明确错误
- structured completion 继续通过 intent、delegation、worktree、verification 和
  stop hook 门禁；普通非结构化响应继续保留 reasoning content 与既有调用兼容性

### ✅ 测试相关

- 新增 schema authority、provider passthrough、bounded retry、crash recovery、
  durable mailbox、Task retry、CLI loader、Headless JSONL、ACP `_meta`、Web SSE
  race、composer draft、report card 和 TUI projection 回归
- 真实 GPT Web route、Claude ACP 与 DeepSeek Headless 分别在 3.229s、2.278s、
  2.999s 返回宿主验证后的对象，3/3 通过且输出、事件、历史均无 credential 泄漏
- Production DeepSeek Web GUI 无刷新显示
  `{"surface":"gui","ok":true,"summary":"Production DeepSeek GUI verified","metrics":{"count":7}}`；
  fresh tab、中英文、digest `8c723790cc`、内部工具隐藏与零 console error 均通过
- clean release tree 通过 CLI 2818 个 deterministic tests、15 个 performance
  tests、Web 384 个 tests、CLI/Web type-check 与 lint、production build 和 bundle
  budget

## [0.10.7] - 2026-08-11

### ✨ 新功能

- 新增 Session-native 独立只读 Code Review，支持 `/review uncommitted`、
  `/review base <ref>`、`/review commit <sha>` 与 `/git review`；CLI/TUI、Web、
  ACP 使用同一 target resolver、reviewer child Session 和 structured finding 协议
- target digest 绑定 resolved commit identity、tracked/staged/unstaged/untracked
  内容与精确 changed line，统一限制为 500 个文件和 8 MiB；review 期间 target 变化
  会标记 `stale`，越界 path/line、错误 priority 或非法输出整体 fail closed
- 内置 reviewer 只允许 Read/Glob/Grep 与分类后的只读 Bash；OS sandbox 禁止 workspace
  写入和网络，屏蔽 HOME、Blade storage、provider credentials，并用隔离 Git config
  保持本地目标可读
- `review_started` / `review_completed` 形成 durable 生命周期；restart 不重放模型，
  completion 后崩溃可从事件恢复报告，abort/delete、fork、rewind 均有明确终态语义
- Web Task Home 原生评审入口实时显示只读工具与完成报告，无需刷新；structured report
  chrome、任务状态与标题支持中英文切换，fresh tab 可恢复相同结果

### 🐛 问题修复

- Web TypeScript target/lib 升级到 ES2022，消除 `tsc --incremental` 缓存对
  `Array.prototype.at` 配置错误的掩盖，并收窄 FileReader test mock 的 callable 类型

### ✅ 测试相关

- 新增三类 target、aggregate budget、target identity、deleted-line、single-active、
  abort、stale、interrupted、crash projection、fork/rewind、finding contract、
  audit permission/sandbox、Web live SSE 与双语 report 回归
- 真实 GPT API 分别通过 production Web route、ACP `/review` 与 TUI runtime hook
  找出同一授权绕过，且文件 bytes 与 Git status 不变
- Production DeepSeek Web GUI 在 1 秒内显示两个只读工具、3 秒内无需刷新完成 P0；
  中文/英文与 fresh-tab 均恢复 `authorization.ts:L8`、confidence `0.99` 和 completed，
  console 仅有 idle info，目标 SHA-256 与 Git status 保持不变
- 最终 feature tree 在 detached clean worktree 通过 14/14 qualification，包括
  2590 个 unit、379 个 Web、integration/security、production build、bundle 和
  performance 门禁

## [0.10.6] - 2026-08-11

### ✨ 新功能

- 权限确认、`AskUserQuestion`、MCP Elicitation 与 Sampling 请求升级为 Session-owned
  durable interaction ledger；request 在 surface 可见前落盘，response 在工具继续前
  落盘，CLI/TUI、Web、ACP、headless 与 print 共用同一恢复协议
- 进程在用户回答后、原工具结束前退出时不重放不确定副作用；Blade 会关闭原 tool
  call、将决定写入 durable inbox，并以 pending-only turn 让模型检查当前状态后继续
- Web fresh load、TUI resume 与 ACP `session/load` 可恢复未回答交互；fork 不继承
  live pending state，rewind 会移除 checkpoint 后的 interaction 生命周期
- 交互请求和响应使用 128 KiB 上限并绑定已提交 tool call；MCP Elicitation 表单
  content 永不写入 transcript，崩溃后需要敏感字段时必须重新请求

### ✅ 测试相关

- 新增 request-before-surface、response-before-continuation、fail-closed 副作用、
  schema/size 边界、MCP 表单脱敏、fork/rewind、HTTP cold response、Runtime mailbox
  reload 及 TUI 启动顺序回归
- 真实 GPT API 分别从 Web、ACP 与 React Ink/TUI 恢复结构化问题，并实际执行一次
  `Write`；production DeepSeek Web GUI 验证 fresh-load 问题卡片、Canary 回答、
  `Canary\n` 精确文件、changed files、fresh tab 不重复提问和零 application error
- 最终 feature commit 在 detached clean worktree 通过 14/14 qualification，包括
  2570 个 unit、372 个 Web、integration/security、production build、bundle 和
  performance 门禁

## [0.10.5] - 2026-08-10

### ✨ 新功能

- 权限模式升级为 Session-owned durable metadata；`default`、`autoEdit`、`yolo`
  与 `plan` 在 CLI/TUI、Web、ACP、headless 和 print resume 中使用同一恢复优先级，
  显式入口参数继续覆盖 Session 历史值
- Web 切换历史 Session 会恢复对应权限模式，新任务固定重置为 `autoEdit`；ACP
  load/fork/setSessionMode、TUI resume/fork 和 task dispatch 均继承并持久化模式
- Plan 批准后的权限切换先写入 durable Session，再通知当前 surface 并继续执行，
  持久化失败时 fail closed，避免跨 Session 全局状态污染或错误启动工具

### ✅ 测试相关

- 新增 durable create/update/fork、Runtime snapshot、Web/ACP/TUI/headless/print
  恢复、显式覆盖、持久化失败和 Plan 执行顺序回归
- 真实 GPT API 验证 Web、ACP、headless 与 React Ink/TUI 从 durable YOLO Session
  恢复后实际执行 Write；production Web GUI 验证 fresh load 为完全访问、新任务重置
  为自动审批、返回历史 Session 再恢复完全访问，且无应用 console error
- 最终 feature commit 在 detached clean worktree 通过 14/14 qualification，包括
  2560 个 unit、372 个 Web、integration/security、production build、bundle 和
  performance 门禁

## [0.10.4] - 2026-08-10

### ✨ 新功能

- Hooks 运行时启停改为 Session scope；CLI/TUI、Web 与工具执行链共享同一状态，
  source project 和 task worktree 使用 canonical alias，Session dispose 会完整清理
- Plugin 设置新增 global/project/local/invocation 分层 provenance；TUI 和 Web
  可选择写入层级，并显示实际生效层与每层开关状态
- Web Settings 完成中英文生产化和跨分组键盘导航；Hooks switch 使用后端实际状态，
  Plugin scope 完整本地化，新 Web 任务默认使用自动审批模式

### 🐛 问题修复

- `communicationStyle` 现在正确持久化到全局 `config.json`；运行中切换界面语言会立即
  重算快捷键标签
- Web 开发服务器补齐 `/hooks` 与 `/plugins` 控制面代理；本地 qualification 先构建
  production Web bundle，再执行依赖产物的 Web 测试

### ✅ 测试相关

- 新增 Hook Session 隔离、project/worktree alias、非法 Session ID、Plugin
  provenance、TUI 控制和 Web Settings 回归
- 真实 DeepSeek API 完成 Hook trust、Plugin lifecycle 与 Marketplace 三条轨迹；
  production Web GUI 验证中文设置、插件层级启停、Session Hook pause、键盘导航及
  零 console error
- 最终 release HEAD 在 clean worktree 通过 14/14 qualification，包括 2546 个 unit、
  133 个 integration、369 个 Web、CLI/headless/E2E/security/performance 与
  production build

## [0.10.3] - 2026-08-10

### ✨ 新功能

- 非平凡实现现在必须通过 fresh independent verification gate：三文件或
  backend/API/infrastructure 改动会强制启动保留的内置 `verification` subagent；
  只有与最后一次源码修改同 revision 的结构化 PASS 才允许完成，FAIL/PARTIAL 和
  PASS 后继续写入都会要求修复并重新验证
- verifier prompt 由 runtime 注入原始请求与真实 changed files；即使父会话为 YOLO，
  verifier 也只能执行项目内只读命令和 test/lint/type-check/build，用户、项目、
  plugin 与 CLI agent 配置不能覆盖保留 verifier
- 本地 verifier Bash 使用 workspace read-only sandbox，关闭网络并屏蔽 user
  home、Blade storage、provider key 与 Session env；显式 Bash deny 仍保持最高优先级
- TUI/headless、Web 与 ACP 统一投影 verifier lifecycle 和 verdict；Web PASS badge
  通过 durable `subtask_ref` 在 server restart 后恢复

### ✅ 测试相关

- 新增策略、权限、durable restore、PASS 后失效、FAIL/PARTIAL、重试耗尽和
  CLI/Web/ACP 回归；真实 DeepSeek Flash 轨迹执行三文件 ApplyPatch、fresh child
  verifier 与真实项目测试
- Production Web GUI 验证唯一 verification 卡片、唯一 PASS badge、三个 changed
  files、最终 marker、server restart fresh-load、零内部 reminder 与零 console error

## [0.10.2] - 2026-08-10

### 🐛 问题修复

- Web production build 现在显式覆盖 `NODE_ENV=production`，避免 CI 的全局测试环境将
  React development runtime 打入 npm 产物并误触 initial bundle 预算

### ✅ 测试相关

- 新增 build environment 契约测试，并在 `NODE_ENV=test` 下真实重建 Web bundle；
  initial JS gzip 从 CI 失败时的 284,231 B 恢复为 220,326 B

## [0.10.1] - 2026-08-10

### 🐛 问题修复

- TUI 新增 production terminal input framing：显式管理 bracketed paste mode，
  完整处理 multi-character/IME chunk、split paste marker 与 CRLF，并同步维护
  value/cursor ref，避免 React batch 内快速输入互相覆盖

### ✅ 测试相关

- 新增 TUI parser、component、raw Ink TTY 和 production PTY 回归；真实 DeepSeek
  transparent proxy 直接验证完整 bracketed paste prompt 进入 provider body，Web GUI
  smoke 验证 `/shell`、fresh-load 与零应用 console error

## [0.10.0] - 2026-08-10

### ✨ 新功能

- 同一模型响应中的工具调用统一使用 shared/exclusive FIFO gate：纯读、不同路径写入、
  独立 Bash 和 durable Task 可并行，共享状态操作保持独占
- Web 与 TUI 支持同时展示多个 subagent 进度；Web 按 child session/tool-call ID
  独立更新并从 durable transcript 重建，ACP 保持独立 tool-call 投影
- 配置型 Hooks 新增 canonical project path + SHA-256 摘要信任；信任记录使用
  `0600` 原子存储，Git linked worktree 共享 common checkout 身份，配置变化自动失效
- Web Settings 新增 Hooks review/trust/revoke 面板；TUI、headless 与 ACP 统一支持
  `/hooks status|list|trust|revoke`
- 新增统一 Workspace Trust：未信任项目不能覆盖模型 endpoint、启动 MCP、放宽权限、
  注入环境变量或加载 project plugins/commands/skills/agents/instructions
- TUI 启动前提供 Trust/Continue safely 决策，Web Settings 新增 Security review，
  CLI/ACP 支持 `/trust` 与 `--trust-workspace`
- MCP 改为按 source project 解析并由每个 Session 独占连接；workspace、plugin、
  ACP 和 `--mcp-config` 使用统一优先级，stdio 默认在目标项目 cwd 启动
- 新增 Session-scoped MCP Form/URL Elicitation：TUI/Web 提供结构化输入和安全外链
  确认，ACP 对可表达字段使用标准 choices、其余 fail closed；支持
  Elicitation/ElicitationResult trusted Hooks
- 新增 Session-scoped MCP Roots 与受控 Sampling：roots 返回 canonical execution
  workspace，ACP remote 不暴露宿主路径；Sampling 默认关闭，显式启用后按请求限制
  token/输入/次数并在 TUI、Web、ACP 强制 one-shot 审批
- 新增 MCP Tool Call 生命周期：Session abort 直达 SDK/server，idle progress 可续期但
  hard timeout 不可突破；统一 `tool_progress` 投影到 TUI、Web、headless、ACP 和
  subagent
- 远程 MCP OAuth 收口到 SDK 标准 discovery/DCR/PKCE：连接只消费已有凭证，
  CLI/TUI/Web 显式登录，Web 支持刷新后恢复授权，token 使用 endpoint/client/scopes
  隔离的 0600 原子账本
- 新增 Dynamic MCP Catalog：`list_changed` 经过有界分页、通知合并和 provider
  boundary barrier 后发布单调 revision；Session/Agent 原子替换
  `mcp__<server>__<tool>` 投影，CLI/Web/ACP 统一展示 delta，非法目录保留上一版本
- 新增 Session-scoped MCP Resources、Resource Templates、Prompts 与 Subscription：
  完整分页目录、deferred list/read/get 工具、角色化 prompt、blob 摘要化和显式资源
  更新订阅统一投影到 TUI、headless、Web、subagent 与 ACP
- 新增 Session-safe MCP Fault Recovery：stdio/remote transport 关闭、Session 过期和
  真实 ping 失败统一进入 generation-fenced single-flight 状态机；旧目录先撤销，
  desired subscription 在新目录提交后恢复，TUI/Web/headless/ACP 展示恢复 revision
- 新增 MCP Tool Result 安全边界：text/structured/binary 使用硬累计预算，base64
  转为 SHA-256 与 0600 Session 私有 artifact，大文本返回首尾预览；Web metadata
  使用严格 allowlist，ACP remote 不暴露宿主 artifact 路径
- 新增 Session-scoped MCP Logging：标准 `logging/setLevel` 协商与运行时调级，
  notification 经过深度/bytes/rate/ring 预算和凭证脱敏后统一投影到
  TUI/headless/Web/subagent/ACP；日志不进入 provider context，ACP 只显示 opaque hash
- 新增 Session-safe MCP Server Instructions：initialize instructions 经过 NFKC、
  隐藏 Unicode、单 server/Session bytes 预算和 JSON/XML 边界处理后，按连接
  generation 动态加入/撤销 provider context；ACP 只保留 provenance hash
- 新增 Session-scoped MCP Completion：prompt 参数与 resource template 变量可通过
  `CompleteMcpArgument`、`/mcp complete` 和 Web 面板补全；候选具备 catalog
  ownership、Unicode/bytes/并发/超时预算和 raw SHA-256 provenance
- 新增 opt-in Session-safe MCP Async Tasks：required/optional task tools 统一使用
  opaque `mcp_task_*`、`TaskOutput`、取消和全端生命周期投影；Session dispose 负责
  回收，`tasks/get`/`tasks/result` 断流可在 generation fence 下恢复
- 新增 Durable Session Archive：JSONL 根事件与 fork/subagent lineage 原子投影整棵
  归档子树，active/archived catalog 使用独立 cursor；TUI、Web 和 HTTP 支持归档/恢复，
  ACP/Runtime 在初始化 owner 前拒绝归档 Session
- Web Sidebar 新增高密度 Archive Popover；Session 行支持键盘可达的 Archive，
  inherited child 显示归档根且不能错误局部恢复，跨 tab 通过 lifecycle Bus 即时收敛
- 新增 Portable Session Markdown Export：从 rewind 后 durable JSONL 投影
  user/assistant、summary 与安全化 activity；reasoning 显式 opt-in，正文携带
  SHA-256，TUI 使用 0600 no-clobber，Web 支持 active/archived 下载，ACP bounded inline
- 新增 Session-scoped Reasoning Effort：`auto/off/minimal/low/medium/high/xhigh/max`
  按模型能力协商并持久化；TUI `/effort`、Web Composer 与 ACP config option 共享
  Runtime 原子切换、active-turn 防护和 metadata 失败补偿回滚
- 新增 Session-scoped Service Tier：`auto/standard/fast/flex` 按模型能力协商并
  持久化；OpenAI 映射 `default/priority/flex`，Claude Opus 4.6 映射 Fast Mode；
  TUI `/speed`/`/fast`、Web Composer 与 ACP config option 共享原子切换与继承语义
- 新增 Session-scoped Response Verbosity：`auto/low/medium/high` 按模型原生能力
  协商并持久化；OpenAI Chat/Responses/Codex 分别投影 `verbosity`、
  `text.verbosity` 与 `textVerbosity`；TUI `/verbosity`/`/detail`、Web Composer
  和 ACP config option 共享五元 Session 设置组的原子切换、回滚与继承语义
- 新增 Session-scoped Communication Style：`auto/pragmatic/friendly/explanatory`
  与 Provider verbosity 正交；受限 prompt section 不能覆盖安全、权限、工具或任务
  规则；TUI `/style`/`/personality`、Web Composer 与 ACP config option 共享 durable
  恢复、active-turn 防护和子 Session 继承
- 新增 Trusted Custom Output Styles：从 user、受信 project 与 active plugin 的固定
  Markdown 目录加载 namespaced style；symlink/path/Unicode/bytes/count 预算
  fail closed，Session 快照与 durable SHA-256 provenance 阻止重建时内容漂移，
  Web/ACP 只投影安全摘要
- 新增 Trusted Contextual Project Rules：支持 `CLAUDE.local.md`、
  `AGENTS.override.md`、`.claude/rules`、`.blade/rules` 和 `paths` frontmatter；
  Session catalog 冻结后按工具触达路径增量加载，首次写入先阻断再重试，JSONL 只保存
  relative path 与 SHA-256 provenance
- 新增 Session-owned User Shell Command：`! <command>` 在精确 Session workspace
  使用冻结环境和 owned process tree 执行，不创建 Agent 或模型请求；TUI、Web、
  print、headless 与 ACP 共享 durable history、输出预算、取消和 UI-safe 投影
- Subagents、skills、custom commands 与 plugins 改为按 canonical workspace 持有；
  Session 创建不可变资源快照，Task/Team 的前后台与 resume 子 Session 显式继承
- `--agents` 只覆盖当前 Session，`--plugin-dir` 在 CLI 模式分流前统一传播到
  TUI、print、headless、serve 与 ACP
- 模型配置与 PiModelCatalog 改为 source-project Session 快照；Task/Team 子 Session、
  fallback 与 Prompt Hook 显式继承，Web/ACP 模型选项按精确 workspace 投影
- `env`、`maxTurns`、`permissionMode` 与 `disableAllHooks` 改为 source-project
  Session 快照；SessionStart 输出在初始化期校验并冻结，CLI/TUI、Web、ACP、
  Bash、Hooks、stdio MCP 与子 Session 共享同一环境契约
- Plugin enable/disable 改为 user/project/local 分层持久化；TUI 支持交互启停，
  Web Settings 新增 Plugins 面板，CLI/headless/ACP 共用 `/plugins --scope` 语义
- Plugin Hooks 新增来源归属、plugin root 环境和 Session 私有快照；同事件多插件
  使用一次原子集合替换，不再互相覆盖
- 新增 Plugin Marketplace 与受管包账本；Git/本地来源经过显式 trust、路径与
  symlink 限制、内容摘要校验后发布到不可变版本目录，更新原子切换且保留活动
  Session 的旧根
- TUI、CLI/headless/ACP、Web Settings 与 HTTP API 统一支持插件安装、更新、卸载
  和 Marketplace add/list/update/remove；卸载及 Marketplace 删除要求显式确认和
  依赖级联保护
- Plugin manifest 的 `bladeVersion` 与 semver dependencies 进入生产门禁；同
  Marketplace 传递依赖按拓扑顺序一次提交，运行时固定点降级缺失、版本不符或禁用
  依赖，卸载拒绝破坏反向依赖
- 新增 tighten-only `pluginSourcePolicy`：Git host、Marketplace、本地根目录 allowlist
  与完整 commit SHA pinning 由 CLI/TUI、Web、ACP 共用，项目层不能放宽用户策略
- `package.json` scripts 进入 Workspace Trust review；post-edit `type-check` 改为
  trusted+YOLO 本地 Session 私有能力，使用冻结环境和 owned process tree
- 新增 Session-scoped LSP code intelligence：支持用户/可信项目/plugin `.lsp.json`
  来源、不可变子 Session 快照、deferred LSP 工具和 Edit/Write 增量诊断
- 新增原子多文件 ApplyPatch：严格 grammar、完整 preflight、canonical path containment、
  多路径/跨进程锁、同目录 staging/backup、fsync、crash journal、失败 rollback 和
  Add/Delete/Move rewind

### 🐛 问题修复

- 修复生产默认 streaming 路径把多个 Task 串行执行，而非流式 fallback 又无条件并行
  副作用工具的语义分裂
- 修复并行 Task 在 Web/TUI 中互相覆盖、后一个 child 的 delta/完成状态污染前一个卡片
- 修复 Web/ACP 多 workspace Hook 配置回退到进程 cwd 或最近加载项目，以及
  Pre/Post/Permission/Stop 快速路径使用全局 `isEnabled()` 导致跳过正确 workspace
- 未信任、已修改或信任存储异常的 command/http/prompt Hook 现在统一 fail closed；
  进程内 managed Function Hook 保持跨 workspace 生效且不进入项目摘要
- Folder Trust 使用 canonical source project identity、父目录继承与最具体子目录 deny；
  revoke 会立即重载过滤配置、断开 MCP 并清理项目资源 registry
- 修复 Web/TUI 多项目 Session 继承服务器启动项目 MCP、builtin tools 混入全局 MCP
  工具，以及 foreground subagent 绕过 SessionRuntime 资源边界
- 修复 Web terminal task 进入完成/失败状态后继续缓存 runtime 和 stdio MCP 进程；
  修复项目绑定弹窗关闭后残留 modal portal 并锁死页面交互
- 修复 MCP client 宣称 sampling/roots 能力却没有 request handler，以及 Web
  AskUserQuestion 仍调用不存在旧路由；交互响应现在统一按精确 Session ref 返回
- 修复外层 MCP tool call 忽略 Session abort、配置 timeout 未生效、长调用无 progress，
  以及 SDK 将用户取消包装成 timeout 导致终态误分类
- 修复 MCP error/critical 日志在 Web 中被统计为失败工具调用；日志现在始终使用完成态
  诊断卡并保留独立 severity 标签
- 修复 Blade 忽略 MCP initialize instructions，导致模型缺失 server-specific 工具
  参数约束；旧 generation instructions 现在会在断连时同步撤销
- 修复 MCP prompt/template 缺少标准 `completion/complete` 客户端路径；未知引用和
  context 现在会在协议请求前 fail closed，取消后连接保持可复用
- 修复 MCP task Web 卡片忽略同一 task 的终态更新并把 working 误显示为 success；
  `tasks/result` 断流现在会在剩余 local lifetime 内恢复，而非误标失败
- 修复 SQLite 同步在权威 JSONL 时间戳早于旧投影时误保留 stale metadata；规范
  transcript 现在始终覆盖自身派生行，只有非规范 alias 来源才按时间择新
- 修复 Web 初始窄视口后变宽时 mobile sidebar transform transition 可冻结在屏幕外；
  移动端抽屉改为即时 transform，桌面仅过渡宽度
- 修复 MCP OAuth 连接时隐式打开浏览器、固定手写 authorization/token endpoint、
  同名 server 跨项目复用 token、非原子凭证写入和 ACP 读取宿主凭证；修复 Web
  `Open MCP Panel` 死循环及异步 popup 被拦截后无法继续授权
- 修复 TUI 启动阶段把 `--agents` 写入共享 registry、worktree child 重新按执行目录
  查找资源，以及模型工具描述在回合中二次读取全局 SkillRegistry
- 修复 Web 工具审批事件遗漏 `toolName` 与 `args`，导致 SlashCommand 等请求错误显示为
  `Edit`
- 修复 Web 多项目和 ACP 多 cwd Session 从启动 Store 查找模型、共享可变 Provider
  catalog，以及项目切换时迟到 `/models` 响应覆盖当前模型列表
- 修复 TUI SessionStart 把项目环境写入 `process.env`、非启动 workspace 继承启动项目
  执行设置，以及项目配置重写进程级 Task scheduler 并发策略
- 修复 plugin refresh 丢失内存态禁用、禁用后旧 Hook 继续触发或活动 Session 立即失去
  Hook，以及 install/update/uninstall 需要手动刷新并遗留启停 tombstone
- 修复插件安装通过 shell 字符串执行 Git、原地 `git pull` 失败后破坏当前版本、
  URL 可嵌入凭据，以及受管包被修改后仍静默加载
- 修复 manifest 已声明依赖和 Blade 版本却从未校验、禁用依赖后 dependent 资源仍
  进入新 Session，以及 full-SHA 来源未复核 checkout HEAD
- 修复 AutoVerify 在未信任项目、`default`/`autoEdit` 与 ACP 远端写入后绕过权限
  执行 package scripts，跨 Session 共享缓存，并通过 `npx` 隐式下载 lint/test 工具
- 修复 ToolSearch 激活 deferred schema 后 provider 工具列表冻结，导致模型拿到 LSP
  schema 仍无法调用；每轮 provider boundary 现在重新解析已加载工具
- 修复 FileLockManager 等待后才登记锁导致三方排队可并发穿透并永久保留已完成 lock；
  修复 FileAccessTracker 把 `/var`/`/private/var` 和 symlink alias 误判为不同文件
- 修复 ACP Client 已声明远端 filesystem 后 read/write 失败回退同名本地路径的
  split-brain 风险；远端 ApplyPatch 现在只允许可验证补偿回滚的 Update

### ✅ 测试相关

- 新增真实 GPT production tool-call 资格，证明未信任 Hook 零副作用、信任当前摘要后
  才执行；生产 Web GUI 覆盖 review、trust、modified、re-trust、revoke 与焦点恢复
- 新增信任文件 owner/mode/symlink、stale digest `409`、worktree identity、跨项目配置
  隔离、ACP callback 和 managed Function Hook 回归
- 新增真实 GPT Workspace Trust 轨迹，证明恶意 endpoint 和 MCP marker 零命中；补齐
  project config、permissions、plugins、commands、skills、agents 和 instructions 门禁
- 新增真实 GPT 双 workspace MCP 轨迹，证明只启动目标项目 server、目标 cwd 正确且
  source project marker 保持零命中
- 新增真实 stdio MCP Elicitation、TUI/Web/ACP、Hook、abort、重叠调用与 schema
  安全测试；真实 GPT 和生产 DeepSeek GUI 覆盖 ToolSearch → Form → 后续执行
- 新增真实 stdio MCP Roots/Sampling、能力协商、text/image、并发、abort 和 ACP
  host-root 隔离测试；真实 GPT 与生产 DeepSeek GUI 覆盖 nested sampling、逐次审批、
  fresh-tab 恢复和 stdio PID 回收
- 新增真实 OAuth + Streamable HTTP MCP 集成，覆盖 discovery/DCR/PKCE、refresh、
  persistence/logout、ACP 隔离与 PID/端口回收；真实 GPT 和生产 DeepSeek GUI 覆盖
  ToolSearch → OAuth MCP → Write、授权恢复、自动重连和 fresh-tab
- 新增真实 stdio MCP progress/cancel/idle/hard-timeout 测试；真实 GPT 覆盖
  ToolSearch → progressive MCP → Write，生产 DeepSeek GUI 覆盖折叠组实时进度、
  fresh-tab 恢复和 PID 回收
- 新增真实 stdio MCP logging 协商、动态级别、限流、脱敏和 ACP 隐藏测试；真实 GPT
  证明日志 marker 不进入模型上下文，生产 DeepSeek GUI 覆盖诊断卡、管理面板和
  error 日志不污染 failed tool count
- 新增真实 stdio MCP instructions V1/crash/V2 生命周期、隐藏 Unicode 和伪 reminder
  边界测试；真实 GPT 与生产 DeepSeek GUI 均从 server-only code 完成工具调用，
  Web 展示 instruction 卡片与管理面板安全预览
- 新增真实 stdio MCP Completion prompt/resource、并发、取消、Session 隔离与 PID
  回收测试；真实 GPT 与 production DeepSeek GUI 均从安全候选完成 MCP → Write，
  Web 管理面板覆盖 target、partial value、候选 hash 和 truncation
- 新增真实 stdio MCP Tasks required/optional/disabled、ownership、取消、Session
  cleanup、`tasks/get`/`tasks/result` 双断流恢复测试；真实 GPT 与 production
  DeepSeek GUI 完成 opaque task → TaskOutput → Write，并验证终态卡和管理面板
- 新增 Session Archive 子树 lease、递归 CQRS、cursor scope、Runtime/Web/TUI/ACP
  写入栅栏测试；真实 GPT 与 production DeepSeek GUI 均完成归档前后两次真实回合，
  Web 额外验证 archived write `409`、Archive Popover、fresh-tab 和资源归零
- 新增 Session Markdown Export rewind/orphan activity、reasoning visibility、
  credential/path/binary redaction、预算、hash、no-clobber 和跨端测试；真实 GPT 与
  production DeepSeek GUI 均验证 Read 证据保留、敏感值消失及 active/archived 下载
- 新增 Response Verbosity capability、payload hook 合并、fallback fail closed、
  durable 恢复、Task/Team 继承和跨端回归；真实 GPT 与 production Web GUI 直接验证
  `low/high` 请求、两次 streaming 响应、fresh-load 四元组恢复和零应用 console error
- 新增 Communication Style prompt guard、顺序、JSONL/fork、无 Provider 重建、
  Task/Team/background/resume 和跨端回归；真实 GPT 与 production Web GUI 直接验证
  `pragmatic → explanatory` system/developer message、fresh-load 恢复和零应用
  console error
- 新增 custom output style 的 Trust、plugin lifecycle、snapshot、digest drift、
  TUI/Web/ACP catalog 与 prompt boundary 回归；真实 GPT 和 production Web GUI 验证
  project/plugin marker、namespaced durable metadata 与 fresh-load 恢复
- 新增 contextual rules 的 Git-root discovery、Trust/symlink/Unicode/glob/bytes
  预算、nested/conditional 去重、write-before-rule 防护和跨端事件回归；真实 API 与
  production Web GUI 验证规则只在 Read 命中后进入 provider context，fresh-load
  transcript 不包含规则正文
- 新增 user shell 的 UTF-8/ANSI/binary/截断、durable steering、resume、HTTP/SSE、
  headless、TUI/Web/ACP 与真实进程树回归；真实 GPT 透明代理证明 shell 阶段零请求且
  后续 payload 含持久化结果，production DeepSeek Web GUI 验证 command card、真实
  follow-up、fresh-tab 两轮恢复和零内部 XML
- 新增真实 GPT Runtime/ACP 双 workspace plugin command 轨迹、DeepSeek Flash/Pro
  CLI `--agents` 轨迹，以及 production Web GUI 双项目 worktree、Security trust、
  marker 隔离、回切恢复和 fresh-tab console 资格
- 新增真实 GPT 双代理 workspace endpoint 轨迹，以及 production Web GUI A/B
  model/provider 列表切换、乱序响应与零 console error 资格
- 新增真实 GPT A/B workspace Bash 环境冻结轨迹、Web/ACP 精确 workspace 环境轨迹；
  production Web GUI 通过真实 DeepSeek、Bash 审批与落盘 marker 验证 Session env
- 新增真实 GPT Web-disable/ACP-enable plugin 状态机，证明活动 Session 快照稳定、新
  Session 资源与 Hook 立即收敛；production Web GUI 覆盖插件持久开关、Hook 来源审查、
  真实 DeepSeek SlashCommand 回合与 fresh-tab console
- 新增 Plugin Marketplace、source trust、原子失败回滚、旧版本保留、内容篡改、
  路径逃逸、symlink、凭据 URL 和级联删除保护测试
- 新增真实 GPT ACP-install/Web-update Marketplace 轨迹，证明活动 Session 保留 v1、
  新 Session 获得 v2、卸载后资源收敛；生产 DeepSeek Web GUI 覆盖目录选源、可信安装、
  工具调用、双确认更新/卸载、依赖删除保护及 fresh-tab 零 console error
- 新增依赖循环/缺失/版本/固定点、原子 closure、反向依赖、来源 allowlist、环境
  SHA 锁、pin mismatch 和策略跨 workspace 收紧测试
- 生产 DeepSeek GUI 进一步覆盖 project policy 保存、allowlist 下根+依赖安装、
  依赖禁用诊断与恢复、未 pin 远程来源提前拒绝、反向依赖卸载保护和 fresh-tab
  零 console error
- 新增 AutoVerify Trust/ACP/权限模式、Session 队列、取消与 dispose 等待测试；
  真实 GPT 验证未信任零副作用与 trusted+YOLO 类型诊断；生产 DeepSeek Web GUI
  验证 script 安全投影，以及未信任 Default、已信任 Auto Edit 都保持零隐式执行
- 新增真实 stdio LSP 协议、双 Session、ACP、崩溃重启、取消、诊断去重与 PID
  回收测试；真实 GPT 覆盖 ToolSearch/LSP/Write，生产 DeepSeek Web GUI 覆盖完整轨迹
- 新增 ApplyPatch parser/engine、发布故障回滚、symlink、并发、远端模糊失败、
  Snapshot、Hook、LSP、ACP/Web 多 diff 测试；真实 GPT 与 DeepSeek GUI 覆盖三文件轨迹

## [0.8.3] - 2026-08-06

### ✨ 新功能

- 新增进程级顶层 Task Admission Scheduler：默认同时运行 3 个任务、最多排队
  100 个任务，支持全局 FIFO、bounded queue、动态并发上限、排队取消和幂等 permit
  释放
- `Agent.chatStream` 成为 Web、Headless、TUI 与 ACP 的统一 admission 门禁；
  `POST /tasks` 准确返回 `running` 或 `queued`，队列满时返回可重试 HTTP 429
- queue position、queue depth 与 concurrency limit 写入 durable session metadata；
  server 启动时按稳定 FIFO 顺序恢复仍有 inbox 的 queued task
- Web Sidebar 显示 `#N/M queued`，Task Home 显示全局 running/queued 容量；
  TUI、Headless `task_admission` JSONL 与 ACP namespaced `_meta` 投影同一状态
- 新增 `maxConcurrentTasks`、`maxQueuedTasks` 配置与
  `--max-concurrent-tasks`、`--max-queued-tasks` CLI override

### 🐛 问题修复

- active run 不再受 100 条历史 LRU 上限驱逐；running task 收到 abort 后会持有 permit
  直到清理完成，避免 provider 尚未退出时提前超发
- queued/running/terminal 的 durable metadata、SSE 容量尾事件与内存 projection
  保持一致，终态不再残留 `taskQueueDepth: 0`
- CLI override 现在在统一 middleware 中应用，Web、Serve 与 Headless 不再忽略任务
  并发参数
- Web 切换回等待权限的空 transcript task 时，会缓冲 SSE replay、重建 assistant
  容器并恢复 permission/question 卡片
- 否定式 worktree 指令（如 `Do not enter another worktree`）不再误触发强制
  lifecycle completion policy
- 删除 task session 后同步回收其 worktree 和临时分支，避免遗留孤儿 workspace

### ✅ 测试相关

- CLI 全量测试：2030 passed，56 skipped；Web 全量测试：129 passed
- DeepSeek v4 Flash/Pro 的 Web FIFO admission、Headless coding turn 与 ACP durable
  worktree 真实 API 资格 6/6 通过
- 浏览器 GUI 验证 `1/1 running · 1 queued`、Sidebar `#1/1 queued`、权限切换
  replay、queued promotion、最终 `0/1 running`，fresh tab console 为空且网络请求无失败
- 新增 102 个同时 accepted run 的压力回归，以及 queue full、queued cancel、permit
  cleanup、稳定重启恢复计数和 task worktree 删除回收测试

## [0.8.2] - 2026-08-06

### ✨ 新功能

- 新增顶层 `POST /tasks` durable dispatch：一次完成 session 创建、可选 worktree
  隔离、prompt fsync 与后台 Agent 启动
- task session 以实际执行 workspace 作为复合身份，私有持久化完整 worktree lease，
  公共 API 仅投影 source workspace、branch、base commit 与 diffStat
- Web 新增 Task Home composer、Explore/Build/Review/Fix 模板、local/worktree
  上下文切换、任务 Sidebar 状态和详情 artifact bar
- 新增有界 `GET /tasks/:sessionId/diff` Review artifact，支持 tracked/untracked
  unified patch，限制文件数与字节数，并保护 symlink、二进制和大文件
- Headless CLI 新增 `--task-isolation local|worktree` 与稳定 `task_session` JSONL
  事件；TUI 显示隔离分支和 diffStat
- ACP `session/new` 支持 namespaced task isolation metadata，`session/list` 和 live
  update 返回 source workspace、worktree identity 与终态 diffStat

### 🐛 问题修复

- 预隔离 task worktree 现在被 Runtime 识别为外部托管生命周期，不再错误要求模型
  重复调用 `EnterWorktree` / `ExitWorktree`
- Web、Headless 与 ACP 在预隔离会话中隐藏 worktree lifecycle 工具，并统一启用
  workspace 边界保护
- Web Review 不再依赖瞬时 tool message；进程恢复或刷新后仍能从 durable lease
  加载真实 patch
- worktree 创建或 durable metadata 写入失败时回滚干净 workspace；fork 不再继承
  parent task owner、lease 或 artifact

### ✅ 测试相关

- CLI deterministic suite：2010 passed，56 skipped；Web suite：125 passed
- DeepSeek v4 Flash/Pro 的 Web `/tasks` + SSE + Review artifact、Headless
  `--task-isolation` 与 ACP `_meta` worktree 真实 API 资格 6/6 通过
- 浏览器 GUI 验证模板、隔离切换、真实 dispatch、DONE 分组、artifact bar、
  unified patch Review 面板，以及稳定态 console/network 无应用错误

## [0.8.1] - 2026-08-05

### ✨ 新功能

- 新增顶层 Session Task durable 生命周期：`queued`、`running`、`completed`、
  `failed`、`cancelled`、`interrupted`
- `Agent.chatStream` 统一驱动 Runtime、Headless CLI、TUI、Web 与 ACP 状态转换，
  running 状态持久化 owner PID，终态清除 owner
- 新增仅允许 task lifecycle 字段的全局 `/events` SSE；Web `TaskListSlice`
  实时同步复合 session identity，不暴露 prompt、工具参数或 owner PID
- Web Sidebar 改为 RUNNING、QUEUED、INTERRUPTED、FAILED、CANCELLED、DONE
  任务分组，并显示全局 task feed 连接状态
- TUI SessionSelector 显示 durable task 状态；ACP `session/list` 与标准
  `session_info_update` 通过 namespaced `_meta` 暴露同一状态

### 🐛 问题修复

- dead owner 对账使用 `SessionLease` 与新 runtime 跨进程互斥，只在最新 durable
  状态仍由死亡 PID 持有时原子追加 `interrupted`
- runtime 初始化失败会将已有顶层 task 标记为 failed；并发 live owner 的
  `SessionInUseError` 不会误改任务状态
- fork snapshot 不再复制 parent 的 task owner 或运行态，child 在真正执行前保持
  completed
- 旧版零消息 transcript 缺少 task metadata 时按 completed 迁移，避免升级后出现
  永久 queued 历史任务
- real API CLI harness 迁移到 pi-ai 模型配置格式和 `DEEPSEEK_API_KEY` 凭证环境变量

### ✅ 测试相关

- CLI 全量测试 1992 通过，Web 测试 121 通过
- 新增 dead/live owner、跨 workspace 同 ID、stream interruption、取消、初始化失败、
  fork lifecycle、全局 SSE 字段白名单和 Web subscription 竞态回归
- 浏览器 GUI 验证 queued task 通过全局 SSE 无刷新出现、任务分组、复合身份选择与
  task feed 健康状态；console 无应用错误
- DeepSeek v4 Flash/Pro 的 Runtime、Headless CLI、Web HTTP/SSE 与 ACP
  task lifecycle 真实 API 资格 8/8 通过

## [0.8.0] - 2026-08-05

### ⚠️ BREAKING CHANGES

- **模型配置格式变更**：旧字段 `apiKey`、`baseUrl`、`name`、`maxContextTokens`、
  `supportsThinking` 在启动时会被拒绝；需重新通过 `/model add` 配置
- **凭证独立存储**：API Key 移至 `~/.blade/auth.json`（权限 0600），不再写入
  `config.json`
- **Node.js 最低版本**：提升至 22.19.0（pi-ai 依赖要求）

### ✨ 新功能

- **pi-ai 运行时**：`@earendil-works/pi-ai` 替代 Vercel AI SDK 作为唯一 LLM
  抽象层，统一 38+ Provider 的模型调用、流式、工具、缓存与重试
- **TypeBox Schema**：替代 Zod，工具参数原生生成 JSON Schema，零转换直出
- **pi catalog 元数据**：contextWindow、maxTokens、cost、reasoning 等从 pi-ai
  动态获取，不再硬编码
- **Provider → Model → Credential 流程**：TUI、Web、ACP 统一新配置向导
- **精确费用追踪**：每次 API 调用直接累加 token（非做差），优先使用 pi-ai 精确
  `usage.cost.total`；支持阶梯价格与 Anthropic 1h 缓存写入
- **缓存定价端到端**：cacheRead/cacheWrite tokens 从 pi 响应 → Agent 事件 →
  Store → `/cost` → headless JSONL 全链路透传
- **压缩费用计入会话**：自动/手动/紧急压缩的 LLM 调用费用计入 `estimatedCostUsd`
- **resetContextUsage**：压缩仅重置当前上下文占用，保留累计 token 与费用
- Web `/configs` API 过滤敏感字段，不再返回模型数组和环境变量
- Web `/models` API 显式投影公开字段，杜绝凭证泄露
- Add Model 弹窗在凭证为空时真正禁用保存；重打开时清空旧状态
- Edit Model 修复 undefined model 字段导致配置破坏
- FileCredentialStore 写入前强制父目录 0700

### 🐛 问题修复

- 费用累计从"与上次做差"改为每次 API 调用直接相加，修复多轮低估
- 缓存 token（cacheRead/cacheWrite）不再丢失，正确参与价格计算
- 压缩后不再清空会话累计费用（仅重置 inputTokens/outputTokens/totalTokens）
- 启动时校验旧模型配置字段，明确报错而非静默加载

### 🧪 测试

- CLI 单元测试 1832 通过，Web 功能测试 115 通过
- 新增：pi-request-options、session-token-usage、models-routes、config-routes、
  file-credential-store、pi-model-catalog、compaction-cost
- 浏览器自动化验证完整 Provider→Model→Credential→Edit→Delete 流程

## [0.7.8] - 2026-08-05

### ✨ 新功能

- foreground 与 background Task 都会持久化可恢复的 subagent sidecar；每次
  `resume_from` 创建新的不可变 child run，并记录 `rootAgentId`、`resumedFrom`
  和 `resumeDepth`
- resume 冻结源运行的模型、权限、工具、系统提示和隔离配置，并以
  `parent sessionId + projectPath` 复合身份鉴权；原子 sidecar 使用 `0600`
  权限和 `fsync`，运行中 owner 通过 PID 跨进程判活
- TUI `/tasks resume`、Web REST/SSE 与消息卡片、ACP tool lifecycle 和
  headless JSONL 共享同一 durable lineage 协议
- Web subagent 卡片新增 follow-up 输入、恢复中/失败状态、child 结果轮询及
  刷新后的 lineage 重建

### 🐛 问题修复

- tag publish workflow 现在校验 tag/package 版本并幂等处理已发布的 npm
  版本和已存在的 GitHub Release，失败重试不会因重复资源产生假失败
- session route 测试 double 不再递归导入被 mock 的 Runtime，消除 V8 coverage
  instrumentation 下的模块初始化竞态
- foreground subagent 现在持久化 Agent 实际替换后的 ChatContext，不再保存
  空的初始消息数组
- session history 通过 tool-call ID 关联 `subtask_ref`，刷新后不会丢失
  subagent 卡片或 resume lineage
- Agent Team session ID 改为严格合法格式，避免被 session path 校验拒绝
- 新进程不再把其他存活 Blade 进程中的 running subagent 误判为 orphan

### ✅ 测试相关

- 新增 root → child → grandchild、重启恢复、冻结执行身份、compound owner、
  worktree lease、TUI、Web、ACP 与 headless lineage 的确定性回归
- 新增 Web GUI 恢复、重试、活动回合禁用和刷新后继续恢复测试
- DeepSeek v4 Flash/Pro 的 Runtime、TUI、Web、ACP durable subagent resume
  真实 API 矩阵全部通过
- CLI 启动性能改用重复样本中位数守住 2 秒预算；V8 coverage 编排排除
  wall-clock performance project，性能仍由 production build 后的独立门禁执行

## [0.7.7] - 2026-08-05

### ✨ 新功能

- 新增 strict session catalog 与 durable fork contract，并通过 interactive CLI/TUI、
  Web Sidebar 和 ACP SDK 0.12 unstable `session/list` / `session/fork` 暴露
- 为 shared Runtime boundary、CLI/TUI、Web、ACP 新增 required DeepSeek Flash/Pro
  及显式配置 Claude/GPT/domestic provider 的 qualification coverage
- 新增 durable user-turn rewind：append-only `session_rewound` marker 统一驱动
  resume、catalog、fork、search 与 compaction history projection
- `/rewind` 支持 conversation-only、code-only、conversation + code 三种模式；
  Runtime 在活动 turn、pending input、后台 shell/agent 存在时 fail closed
- 文件快照按 workspace hash + session ID 隔离，避免同 ID 跨 workspace 串线；
  只属于单一 workspace 的 0.7.6 legacy manifest 会在首次使用时原子迁移
- Web 新增 checkpoint 选择对话框、代码恢复开关、跨客户端 SSE 同步和 exact
  `sessionId + projectPath` 路由；ACP rewind 后重建 Agent 并继续使用投影历史
- 新增 Web GUI 组件测试、真实浏览器恢复流程，以及 DeepSeek Flash/Pro 的
  Runtime、TUI、Web、ACP 共 8 条真实 API rewind 轨迹

## [0.7.6] - 2026-08-05

### ✨ 新功能

- 新增 session 级持久化 Goal Mode：目标、状态、token 预算、用量、耗时与续跑次数通过原子 sidecar 跨进程恢复
- 新增 `GetGoal`、`CreateGoal`、`UpdateGoal` 模型工具和 `/goal` 命令，模型负责判断目标完成或阻塞，不设置固定自动续跑次数上限
- CLI、Web 与 ACP 支持 active goal 自动续跑、暂停、恢复、编辑、清除及崩溃后唤醒，并共享同一 Goal lifecycle
- Web 新增 Goal 可视化控制栏，提供状态摘要、编辑、暂停/继续、删除确认、详情折叠和 token/耗时统计
- 新增跨 CLI、Web、ACP 的 durable session branch、文件 rewind、结构化用户问答和可取消阻塞交互
- 后台 shell 支持交互式 stdin、输出截断与跨表面状态展示；权限批准可显式选择 session 或 project scope

### 🐛 问题修复

- 修复中断工具调用历史回放不完整、storage-backed session ID 不安全以及阻塞交互无法可靠取消的问题
- Goal 编辑保持原状态，暂停目标不会因修改 objective 隐式恢复；按钮操作不再污染聊天 transcript
- Web Goal 文本命令与可视化按钮在活动 run 中保持一致，不会提前清除 streaming 状态

### ✅ 测试相关

- 新增 Goal 状态机、原子持久化、预算、崩溃恢复、模型工具、CLI/TUI、Web REST/SSE、ACP 和可视化控制栏测试
- 单元测试 1,581 项、Web 测试 44 项及 production build 通过
- DeepSeek v4 Flash/Pro 完整生产矩阵获得 99 项真实 API 通过证据；其中 3 项首轮模型轨迹偏差在隔离复跑中通过
- Goal Core、Web 与 ACP 三条真实 API 轨迹全部通过

## [0.7.5] - 2026-08-03

### ✨ 新功能

- 普通首条 prompt 现在会在模型调用和 `@` 文件展开前写入 session-owned durable inbox，并原子取得 turn ownership
- direct input 使用稳定 `inboxMessageId` 关联 sidecar、JSONL transcript、Web 事件与完成 ACK，崩溃恢复时保持幂等
- Web message POST 按 session 串行提交，只有在 inbox `fsync` 完成后才返回 `202`；CLI、Headless 与 ACP 通过共享 Agent 入口获得相同语义
- 已存在 durable input 时，新 prompt 会按 FIFO 进入 pending-only turn，不会插队或启动并发 run

### 🐛 问题修复

- 修复首条 Web 请求在返回 `202` 后、写入 transcript 前崩溃会永久丢失的问题
- 修复失败的 durable turn 在同一次 run 中最多自动重试 20 次的问题；失败输入现在保留 sidecar，等待显式恢复
- Web loop 失败现在发布 `session.error` 并释放 prepared owner，不再错误发布 `session.completed`
- 为 LLM compaction 增加 2-turn hysteresis，并保留 95% 紧急水位绕过，防止静态 system/tool 开销导致每轮重复压缩

### ✅ 测试相关

- 新增 direct prepare/claim、并发 owner、FIFO backlog、pre-model persistence failure、Web `202` 时序和失败 owner 释放测试
- Production qualification 15/15、单元测试 1,510 项、Web 测试 30 项、真实 API 轨迹 66/66 通过
- DeepSeek v4 Flash/Pro 完整资格通过；Claude Opus 4.8 与 GPT 5.5 的 core、Web、ACP durable initial recovery 轨迹通过

## [0.7.4] - 2026-08-03

### ✨ 新功能

- sealed turn 后提交的输入会持久化为 next-turn follow-up，并由 runtime 原子交接到后续逻辑回合
- CLI 启动、Web SSE 重连与 ACP initialize/session load 会自动唤醒 durable pending input
- CLI、Web 与 ACP 新增 follow-up queued/started 状态协议，并保持 user input 的 FIFO 顺序

### 🐛 问题修复

- 增加 transcript `inbox_acknowledged` 完成标记，修复 user transcript 已写入但模型尚未执行时崩溃导致输入丢失的问题
- 恢复时通过 `inboxMessageId` 幂等复用已持久化 user message，避免 transcript 与界面重复显示
- 修复 Web session hydration、双 SSE 重连和 enqueue/turn completion 之间可能启动重复 run 或遗漏唤醒的竞态
- fork session 不再继承父会话的 inbox acknowledgement 事务状态

### ✅ 测试相关

- 新增原子 seal/enqueue、pending-only turn、completion ACK、FIFO handoff 与 CLI/Web/ACP 自动唤醒故障注入测试
- Production qualification 15/15、单元测试 1,498 项、Web 测试 30 项、真实 API 轨迹 66/66 通过
- DeepSeek v4 Flash/Pro 完整资格通过；Claude Opus 4.8 与 GPT 5.5 的跨 runtime、Web、ACP durable recovery 轨迹通过

## [0.7.3] - 2026-08-03

### ✨ 新功能

- 为 active-turn steering 增加 session 级持久化 inbox，使用原子写入、`fsync` 与 `0600` 权限保存已确认但尚未应用的指令
- runtime 重启后自动对账 inbox 与 JSONL transcript，并在 CLI、Web 与 ACP 显示恢复的 steering 数量
- steering 只有在 transcript 持久化成功后才逐条 ack，支持部分失败和进程崩溃后的幂等恢复

### 🐛 问题修复

- 修复 Web 首次 runtime 初始化期间第二条消息可能只进入内存 backlog 的崩溃丢失窗口
- 将 SessionRuntime、SessionLease 与 ContextManager 统一绑定到显式 workspace root，并使用 transcript `cwd` 恢复权威项目路径
- 拒绝可逃逸项目存储目录的 session ID，并在删除 session 时同步清理 durable inbox
- 在并发 enqueue 下原子执行 steering 条数与内容大小限制

### ✅ 测试相关

- 新增重启恢复、ack 中断对账、部分持久化失败、并发容量、损坏 sidecar、文件权限与 session 删除故障注入测试
- 新增 Web runtime 启动竞态与 CLI、Web、ACP 恢复状态回归测试
- DeepSeek v4 Flash、Claude Opus 4.8 与 GPT 5.5 的真实 API durable restart 轨迹全部通过

## [0.7.2] - 2026-08-03

### ✨ 新功能

- 新增 active-turn steering mailbox，允许用户在 Agent 工作期间排队补充指令，并在 LLM/工具安全边界注入当前回合
- CLI 运行中按 Enter 改为实时转向，保留 Esc 中止语义，并在状态栏显示待处理消息数量
- Web 输入框在 streaming 期间保持可编辑，通过同一 run 的 SSE 暴露 `steering.queued` / `steering.applied`
- ACP 活动 prompt 支持 steering，不再通过新 prompt 隐式中止前一个回合
- SessionRuntime 显式拥有 workspace root，统一 CLI、Web、ACP、Headless 与 Subagent 的项目级规则和 Skills 发现

### 🐛 问题修复

- 防止 Web 对同一 session 启动并发 Agent run
- 修复 Anthropic 历史回放伪造无签名 reasoning block 导致 Claude 拒绝后续指令的问题
- steering 指令会持久化到 transcript，并动态更新验证、委派和 worktree 完成策略
- 移除不再维护的 Spec 模式及其工具、状态与文档入口

### ✅ 测试相关

- 新增 mailbox 所有权、原子封闭、容量限制、失败恢复及跨表面事件测试
- 新增 DeepSeek v4 Flash 的 Web/ACP steering 生产资格轨迹
- Claude Opus 4.8、GPT 5.5、DeepSeek v4 Flash 的 Web/ACP 真实 API steering 轨迹全部通过
- Production qualification 15/15、真实 API 63/63 通过

## [0.7.1] - 2026-08-03

### 🐛 问题修复

- 强制执行显式委派、验证和 yolo 轮次上限，防止 Agent 提前完成或无限重试
- 在验证成功前阻止退出 worktree，并确保生命周期工具始终向模型暴露完整 schema
- 启动时安全清理过期且无未提交、未推送改动的 Agent worktree
- 将自定义 Agent 的完成要求纳入子 Agent 验证策略

### ✅ 测试相关

- 将 Claude 资格模型升级为 `claude-opus-4-8`，GPT 资格模型升级为 `gpt-5.5`
- 规范化 NewAPI `/v1` 地址，并覆盖 Claude、GPT、DeepSeek 的 CLI、Web 与 ACP 真实 API 轨迹
- 增强 worktree、session fork 与自定义 Agent 的真实 API 资格测试

## [0.7.0] - 2026-08-03

### ✨ 新功能

- fork persisted conversations (a141169b)
- load custom agents from CLI (356b2eef)
- load ephemeral settings overrides (a79dbfc2)
- load scoped project instructions (a8b6a2b4)
- switch session models atomically (d5bd12d8)
- restore persisted sessions (6d712a03)
- expose structured tool results (df7f3b40)

### 🐛 问题修复

- require webhook credentials from env (22d71f98)
- assign npm publishing to tag workflow (328ffcec)
- preserve continuation requirements (519438cb)
- dispose session runtime on exit (959149a8)
- expose agent lifecycle events (34f634c8)
- stream compaction lifecycle events (aa777c34)
- preserve headless compaction protocol (46ed652d)
- enforce exit mode boundary (78806782)
- make model retries replay-safe (e23c481c)
- recover truncated session transcripts (e2aad46f)
- serialize session ownership (46145c53)
- persist interrupted turns (3d7ec137)
- scope background tasks to sessions (a30743d6)
- terminate owned process trees (61a78ea9)
- surface recoverable command failures (9308759a)
- invalidate auto-verify after edits (297ab72f)

### 💄 代码格式

- normalize Biome formatting baseline (a8095801)

### ✅ 测试相关

- strengthen publisher ownership contract (3d7445e9)
- isolate real API qualification config (0d5381e7)
- enforce production qualification gates (ebd8b3a4)
- cover real API multi-file migrations (c8aae582)
- cover resumed coding tasks across permission modes (f74df91c)
- add real API coding task harness (8c7c9afc)


## [0.6.2] - 2026-08-01

### ✨ 新功能

- 新增 `EnterWorktree` / `ExitWorktree` 工具，为 Agent 提供 session 级 Git worktree 隔离
- 从仓库子目录进入 worktree 时保留相对工作目录，Bash、Glob、Grep、系统提示与 `@` 引用同步切换
- 新增 Pipeline 隔离门禁：用户明确要求 worktree 时，进入前和退出后禁止执行写入及命令工具

### 🐛 问题修复

- 删除 worktree 前 fail-closed 检查未提交文件和未合并提交，必须显式确认才能丢弃
- 修复非零退出码的 Bash 测试命令被误判为验证成功的问题
- 修复 worktree 内权限与失败 Hook 仍使用进程原始 cwd 的问题

### ✅ 测试相关

- 新增 8 项真实 Git 生命周期测试和 Pipeline 隔离测试
- 新增真实 DeepSeek worktree 轨迹，验证原 checkout 不变、隔离编辑、测试和退出协议

## [0.6.1] - 2026-08-01

### ✨ 新功能

- 增加显式验证完成门禁：用户要求运行测试、Lint、类型检查或构建时，Agent 必须成功执行对应命令后才能报告完成
- 增加隔离临时项目的真实 Agent 轨迹测试，覆盖读取、编辑、命令执行和结果复验

### 🐛 问题修复

- 修复 headless 模式忽略 Agent 失败结果并错误返回退出码 0 的问题
- 修复 Stale Loop 告警窗口不重置导致循环无法退出的问题

### ✅ 测试相关

- `ready` 新增真实 API 发布门禁，支持直接读取 `~/.blade/config.json` 当前模型
- 真实 API 套件改为无 mock 串行执行，并为 reasoning 模型预留稳定输出预算


## [0.4.2] - 2026-05-07

### ✨ 新功能

- 优化构建配置和错误处理逻辑 (bb5b8dc)

### 🐛 问题修复

- 修复消息区域清理时光标位置问题 (1752cd3)

### 📝 文档更新

- 添加开发环境搭建、故障排除、快速开始等文档 (8ba6b0a)

### ♻️ 代码重构

- 移除 providerId 并简化 provider 类型处理 (c612a18)

### ⚡ 性能优化

- 优化代码分割和懒加载以提升性能 (14d1977)


## [0.4.1] - 2026-05-06

### ✨ 新功能

- 重构配置向导流程并改进用户提示 (700ff07)

### 🐛 问题修复

- 确保空对象模式显式输出 required 数组 (68f0273)


## [0.4.0] - 2026-05-06

### ✨ 新功能

- 添加 TeamCreate, TeamStatus 和 TeamDelete 到预加载工具集 (bfe79ac)
- 新增 Agent Team 协作功能 (08dceef)

### ♻️ 代码重构

- 重构任务管理工具，将TodoWrite替换为TaskCreate/TaskGet/TaskUpdate/TaskList (f499b80)


## [0.3.6] - 2026-04-30

### ✨ 新功能

- 添加消息流缓冲机制优化高频事件处理 (7fe7f95)

### 🐛 问题修复

- 处理API错误时显示友好错误信息并允许系统消息 (80bcdd8)


## [0.3.5] - 2026-04-21

### ✨ 新功能

- 实现会话恢复时保留原始上下文消息 (d80631f)


## [0.3.4] - 2026-04-21

### ♻️ 代码重构

- 移除 GitHub Copilot 和 Google Antigravity 相关代码 (91cdcdc)


## [0.3.3] - 2026-04-21

### 🐛 问题修复

- 修复重复创建 abortController 导致任务状态错误的问题 (189152a)


## [0.3.2] - 2026-04-18

### ✨ 新功能

- 新增 Function 和 HTTP Hook 支持 (5281f6f)
- 添加并发调度器实现工具调用分桶限流 (0af1b62)
- 添加工具黑名单支持并优化会话处理 (9750322)
- 增强任务中止处理逻辑并支持中断原因区分 (538a058)

### 🐛 问题修复

- 过滤会话消息中的非用户和助手消息 (d9fe11d)
- 修复令牌计数使用 totalTokens 而不是计算值 (db1318e)
- 改进帮助命令输出和权限模式处理 (04e0532)

### ♻️ 代码重构

- 重构权限决策流程为多阶段仲裁 (7165385)


## [0.3.1] - 2026-04-12

### ✨ 新功能

- 实现渐进式工具披露、自动验证传感器和内置验证Agent (618ecae)
- 添加真实仓库基准测试工具和更详细的无头事件 (d4e5ad3)
- 改进代码块和确认提示的显示效果 (deabaee)
- 支持 Markdown 引用块渲染并改进表格显示 (150a48f)
- 重构系统提示构建顺序并模块化默认提示 (7711103)
- 增强Bash命令权限检查的语义分析和规范化 (56d703a)
- 引入统一的 CWD 管理系统 (4b779c6)
- 新增多模态消息处理、错误分类、流式缓冲和slash命令路由功能 (9de54d5)
- 确保恢复分支消息的持久化和正确顺序 (07276fa)
- 流式工具安全与 fallback 事务边界 (Phase 1) (e26212d)
- 添加模型降级处理逻辑 (6d5407d)
- 添加 token 预算递减收益检测功能 (28915fa)
- 添加模型降级和输出恢复功能 (70c77a2)
- 添加上下文压缩和工具结果预算功能 (4024f51)
- 重构 agent 循环为 AsyncGenerator 模式并实现 drainLoop 工具 (b7e6a7b)

### 🐛 问题修复

- 改进发布脚本的远程同步和分支校验逻辑 (c1a8b2c)
- 修复 Enter 键行为，仅用于提交而非接受建议 (0df82e5)
- 修复分支显示和加载文案优先级问题 (98d2730)
- 修复多轮对话中stream_end的finalize问题 (30e7688)
- 修复模型切换后未立即生效的问题 (aafce51)
- 事件协议收敛 + 接口定型 + continue 分支状态修复 (aeccc85)
- 修复最终 code review 发现的三个问题 (6f48b1f)
- 修复 code review 发现的两个问题 (336a46d)
- 删除 SubagentContext 旧命名回调，完成 onEvent 收敛 (99c201a)
- 修复 setTimeout 泄漏并删除不可达类型 (dacb2bc)
- 修复 appendBoth 导致消息重复的 bug (cad0a77)
- 修复工具执行中的信号处理和恢复计数器问题 (d0a4e69)

### 💄 代码格式

- 替换表情符号和箭头为文本标记 (80370a4)

### ♻️ 代码重构

- 重做确认弹窗信息架构，添加 Diff 展开/折叠 (6786a77)
- 简化加载短语列表并更新提示概率 (ca2a234)
- 移除 displayContent 字段并统一工具输出格式 (805ef7a)
- 删除所有 deprecated 代码 (9544bc8)
- 消费者迁移到 chatStream() 统一事件协议 (Phase 4) (6fe4799)
- 删除未使用的 drainLoop 导入 (db5ea8b)
- 接口分层 — chatStream() 成为唯一事件流入口 (Phase 3) (e6657c4)
- 策略提取与语义 bug 修复 (Phase 2) (cb13993)
- 清理 code review 问题 (d9244b4)
- 消除消息双源，统一走 ConversationState (02ad9d7)
- 重构事件类型系统并统一事件处理逻辑 (e52dc3a)
- 修改package.json中的dev脚本路径 (4968015)

### ✅ 测试相关

- 添加多个单元测试文件 (a83ddee)

### 🔧 其他更改

- release v0.3.0 (c2fe9e5)
- ignore project-local worktrees (ffee334)
- 配置 npm 使用官方注册表 (8cbfe8f)
- 迁移项目从pnpm到bun包管理器 (9533cea)


## [0.2.9] - 2026-03-31

### ✨ 新功能

- 支持多模态图像输入功能 (fecd446)
- 添加稳定的工具调用和子代理ID生成功能 (0ae38b7)

### 🐛 问题修复

- API 错误信息友好化，不再向用户暴露完整堆栈 (58b1bd4)
- stop release flow after npm publish failure (1b1d3bf)

### 📝 文档更新

- add web image input design spec (c9b3a51)

### ⚡ 性能优化

- 终端交互层全面性能优化 (82937a8)


## [0.2.7] - 2026-03-24

### ✨ 新功能

- 添加无头模式支持并实现结构化事件流输出 (bd7089e)
- 引入会话运行时管理以支持会话级资源隔离 (5d30dac)
- add native openai provider support (523633b)
- add native openai provider support (5cd1734)


## [0.2.6] - 2026-02-21

### ✨ 新功能

- add /memory edit command with $EDITOR support (75dbfe7)
- add Auto Memory system for cross-session persistent knowledge (4012898)

### 🐛 问题修复

- createTool.execute now passes ExecutionContext to tools (bbd353a)

### 📝 文档更新

- add Auto Memory documentation (b2716e9)
- update README with Auto Memory feature and /memory commands (2ae1dab)

### ♻️ 代码重构

- clean up ContextManager/PersistentStore responsibilities (e799a2f)

### ✅ 测试相关

- add 20 unit tests for ContextAssembler (4bd66f1)
- add Auto Memory unit tests (38 cases) (511c523)


## [Unreleased]

### ✨ 新功能

- **Auto Memory 系统** — Agent 跨会话持久化项目知识（构建命令、代码模式、调试洞察）
  - `MemoryRead` / `MemoryWrite` 工具：Agent 自动读写记忆文件，内置敏感数据过滤
  - `/memory` 命令：`list` / `show` / `edit` / `clear` 管理记忆文件
  - 启动时自动注入 MEMORY.md 前 200 行到 system prompt
  - 环境变量 `BLADE_AUTO_MEMORY=0` 可禁用

### 🐛 问题修复

- `createTool.execute()` 现在正确传递 `ExecutionContext` 到工具函数，修复 `context.workspaceRoot` 等始终为 undefined 的问题

### ♻️ 代码重构

- 清理 `PersistentStore` 废弃方法（`saveContext` / `saveSession` / `saveConversation`）
- 新增 `ContextAssembler`：集中 JSONL 事件流到 ContextData 的重建逻辑，修复 tool calls 和 compaction summary 丢失问题
- 修复 `ContextManager.saveCurrentSession()` 重复写入 JSONL 的问题

### ✅ 测试相关

- 新增 58 个单元测试（AutoMemoryManager 20 + MemoryTools 18 + ContextAssembler 20）


## [0.2.5] - 2026-02-16

### 🔧 其他更改

- upgrade @jrichman/ink from 6.4.6 to 6.4.10 (e6ff7ca)


## [0.2.4] - 2026-02-09

### 🐛 问题修复

- allow root execution in container/sandbox/CI environments (9f02561)

### ♻️ 代码重构

- 重构依赖项结构，将web相关依赖移动到cli/web目录 (1b2a17a)


## [0.2.3] - 2026-02-03

### 📝 文档更新

- 移除内置免费模型的相关文档和代码 (9b5db9d)


## [0.2.2] - 2026-02-01

### ✨ 新功能

- 支持单次对话指定模型功能 (80e80c5)


## [0.2.1] - 2026-02-01

### ✨ 新功能

- 增强子任务执行状态展示和交互 (f725f00)
- 添加子代理会话ID支持并优化相关功能 (c39a083)
- 添加bun-pty类型定义并修复pty调用 (ae75567)
- 添加全面的单元测试、集成测试和端到端测试 (4e7ce95)

### 🐛 问题修复

- git operations should run in monorepo root to include changelog (913d26c)

### 📝 文档更新

- 更新文档以反映0.2.0版本新增的Web UI功能 (b583c93)

### ♻️ 代码重构

- 重构子会话实现为独立会话模型 (6b7f4c9)

### ✅ 测试相关

- 修复测试中文件路径和模拟数据的错误 (f674f49)
- 修复单元测试问题 (eb6a72b)
- 大幅提升测试覆盖率和测试基础设施 (12650b1)


## [0.2.0] - 2026-01-30

🎉 **重大更新：Web UI 发布！**

本版本带来了全新的 Web UI 界面，让你可以在浏览器中使用 Blade Code。

### ✨ 新功能

#### 🌐 Web UI（全新）
- **完整的 Web 界面** - 在浏览器中使用 Blade Code，支持所有核心功能
- **`blade web` 命令** - 启动 Web 服务器并自动打开浏览器
- **`blade serve` 命令** - 启动无头服务器模式，适合远程访问
- **实时终端** - 支持 WebSocket 连接的终端功能
- **会话管理** - 创建、切换、恢复会话
- **模型管理** - 在 Web 界面中配置和切换模型
- **权限控制** - 支持权限模式切换和操作确认
- **多语言支持** - 中英文界面切换

#### 💻 CLI 改进
- 支持展示所有变更文件并允许展开/折叠差异 (a96ac69)
- 移除 pino 日志库并实现自定义日志系统 (d5b5b67)
- 支持 Node.js 环境的终端 WebSocket 连接 (ff2cde1)
- 添加多语言支持并优化 UI 主题配置 (de2fe52)
- 添加权限模式支持并优化侧边栏样式 (5b83127)
- 添加终端功能及 UI 改进 (37831e3)
- 实现临时会话功能并增强侧边栏 (4c598e9)
- 添加模型管理和会话功能 (c85cff9)
- 实现聊天会话管理和消息流式处理功能 (9b2682c)

#### 🖥️ 服务器
- 新增 Blade 服务器核心功能及 API 路由 (52e3db3)
- RESTful API 支持会话、模型、配置、权限等管理
- WebSocket 支持实时消息推送和终端交互
- 支持 CORS 配置和 Basic Auth 认证

### 🐛 问题修复

- 修复 Web 静态资源路径检测问题 (b778444)

### ♻️ 代码重构

- 简化 monorepo 架构 (1c820dd)
- 重构消息组件和状态管理逻辑 (05e579a)
- 重构会话存储结构，移除工具切片并优化事件处理 (e6fe25e)
- 重构会话存储结构，将状态管理拆分为多个切片 (785bd56)
- 重构会话管理及事件处理机制 (18d75a5)
- 移除事件总线并重构会话和权限处理 (67a4dab)
- 统一使用 PermissionMode 枚举类型 (11b3b4d)

### 📖 升级指南

```bash
# 更新到 0.2.0
npm update -g blade-code

# 启动 Web UI
blade web

# 或启动无头服务器
blade serve --port 3000 --hostname 0.0.0.0
```


## [0.1.10] - 2026-01-22

### ♻️ 代码重构

- 使用运行时验证替代静态枚举检查 (ae3c033)


## [0.1.9] - 2026-01-22

### ✨ 新功能

- 添加子任务执行进度显示功能 (a3254c3)
- 重构聊天服务以支持无状态设计和AI SDK集成 (60fce5a)

### 📝 文档更新

- 更新文档内容，添加自定义Provider和OAuth命令说明 (f99a563)


## [0.1.8] - 2026-01-16

### ✨ 新功能

- 添加模型配置向导组件及支持自定义HTTP头 (2dd1f1a)

### 📝 文档更新

- 更新用户文档和配置指南 (338535c)

### ♻️ 代码重构

- 移除 blade-claude 相关代码及依赖 (b39d743)


## [0.1.7] - 2026-01-15

### ✨ 新功能

- 为useConfirmation添加确认对话框队列功能 (91627d2)


## [0.1.6] - 2026-01-15

### 🐛 问题修复

- 移除内置 Claude 模型及相关功能 (e5dfdb4)
- add blade-claude provider to ModelConfigWizard (2976448)

### 📝 文档更新

- remove redundant website button from coverpage (2ef7d7c)


## [0.1.5] - 2026-01-14

### ✨ 新功能

- 添加 Blade Claude 服务支持 (e65ce52)

### 📝 文档更新

- 在 README 中添加启动界面截图 (340ad08)
- 添加启动界面截图 (bb56bee)

### 🔧 其他更改

- 更新启动页截图 (1c6261a)


## [0.1.4] - 2026-01-13

### 🐛 问题修复

- 修复内置模型更新逻辑 (36dd8c1)


## [0.1.3] - 2026-01-13

### ✨ 新功能

- 更新智谱 API 代理服务地址并实现密钥获取逻辑 (176a4ad)
- 改进日志系统以支持会话隔离和优雅关闭 (a319da3)

### 🐛 问题修复

- 统一目录创建权限为755并修复路径处理问题 (f055e1e)

### 📝 文档更新

- 更新文档内容并改进路径处理函数 (7352bac)
- 更新文档链接为新的地址 (0ef2a3b)


## [0.1.2] - 2026-01-12

### 🐛 问题修复

- 更新 changelog 文件路径并移除重复的同步逻辑 (624eb65)


## [0.1.1] - 2026-01-12

### ✨ 新功能

- **WebSearch 集成 Exa MCP**：使用 Exa 公开 MCP 端点进行网页搜索，无需 API key，支持多提供商自动故障转移（Exa → DuckDuckGo → SearXNG）(83cb4c5)
- **WebFetch 集成 Jina Reader**：新增 `extract_content` 参数，使用 Jina Reader 提取网页内容为干净的 Markdown 格式，自动移除 HTML 杂乱内容 (83cb4c5)
- 添加 Discord Webhook 通知功能，发布时自动推送 changelog (d6ce657)

### ♻️ 代码重构

- 清理未使用类型定义并优化代码结构 (ca8b506)
- 重新设计 ToolResult.metadata 泛型类型系统 (83cb4c5)
  - 添加泛型 `Metadata<T>` 类型，实现类型安全的元数据定义
  - 为各工具创建专用元数据接口：ReadMetadata, WriteMetadata, EditMetadata, GlobMetadata, GrepMetadata, BashMetadata, WebSearchMetadata, WebFetchMetadata 等
  - 添加类型守卫函数：isDiffMetadata, isFileMetadata, isBashMetadata, isGlobMetadata, isGrepMetadata 等

### 📝 文档更新

- 更新文档链接和 README 内容 (f2b267c)
- 添加项目文档和代理配置文件 (203140b)

### 🔧 其他更改

- 更新 Node.js 最低版本要求至 20.0.0 (e6f1a70)


## [0.1.0] - 2026-01-11

🎉 **首个开源版本发布！**

### ✨ 新功能

- 重构流式消息处理与Markdown增量解析 (ea391df)
- 支持流式响应中的token用量统计 (6cb5735)
- 添加内置免费模型 GLM-4.7 及相关支持功能 (6295748)

### 🐛 问题修复

- resolve unused variable lint errors (f4e23a6)
- 添加 Bun 运行时支持 (bec375e)
- 在 CI 环境跳过 prepare 脚本避免 bun 依赖 (ef92bc3)
- 使用 npm 安装 pnpm 替代 action-setup 修复兼容性问题 (e18543c)
- 使用 standalone 模式修复 pnpm 安装问题 (e16a57d)
- 使用 pnpm/action-setup 修复 CI 流程 (d75ed21)

### ♻️ 代码重构

- 替换 any 类型为 unknown 或具体类型以增强类型安全性 (0533fdc)

### 🔧 其他更改

- 清理未使用的配置文件和空目录 (codecov.yml, patches/, public/)
- 移除重复的 shell 脚本 (download-ripgrep.sh)
- 移除未使用的代码和导出 (a9db838)


## [0.0.47] - 2026-01-08

### ✨ 新功能

- 实现插件系统核心功能 (7eae689)
- 更新文档结构和内容，优化用户指南和功能说明 (d1579cd)

### 🐛 问题修复

- 指定官方 registry 确保获取最新版本 (c6771e6)

### ♻️ 代码重构

- 移除模型相关配置选项 (ac7dbc9)


## [0.0.46] - 2026-01-07

### ✨ 新功能

- 添加对Claude Code配置的兼容支持 (99f42e9)


## [0.0.45] - 2026-01-06

### ✨ 新功能

- 重构后台任务管理并引入 TaskOutput 工具 (94c5919)

### 🐛 问题修复

- 修复 resume 无法保留对话历史的问题 (d0b39e4)
- 修复 killAgent 无法停止后台任务的问题 (8867b7e)

### ♻️ 代码重构

- 重构子代理注册机制，内置核心代理配置 (5b9189d)

### ⚡ 性能优化

- 优化流式输出渲染性能并改进工具详情显示 (33884a8)


## [0.0.44] - 2026-01-04

### ✨ 新功能

- 实现流式消息处理与性能优化 (e17d0af)
- 优化消息折叠策略并重构渲染逻辑 (1690b10)
- 优化 Spec 模式工作流和状态管理 (979967d)
- improve spec mode (c80ec8e)
- 实现规格驱动开发模式的核心功能 (8534a5e)

### 🐛 问题修复

- 修复消息序列验证问题并更新本地设置 (cad5916)


## [0.0.43] - 2025-12-30

### ✨ 新功能

- 添加 AskUserQuestion 工具支持 (78a44e2)
- 添加统一的代理fetch工具并替换多处直接fetch调用 (b727697)


## [0.0.42] - 2025-12-30

### ✨ 新功能

- 添加 Gemini CLI OAuth 支持并优化用户初始化流程 (e11732b)

### 🐛 问题修复

- 修复命令中止时的竞态条件问题 (a6bed3a)

### ♻️ 代码重构

- 优化确认提示组件性能，分离静态内容 (4e8e990)


## [0.0.41] - 2025-12-28

### ✨ 新功能

- 添加 Antigravity 和 Copilot 的 OAuth 登录功能 (2b31dae)
- 添加同步远程 tags 功能确保 changelog 生成正确 (05a4a23)

### 🐛 问题修复

- 为依赖检查添加超时避免卡住 (1bf7816)


## [0.0.40] - 2025-12-27

### ✨ 新功能

- **多模型提供商支持**：添加对 Anthropic、Google Gemini 和 Azure OpenAI 的原生支持 (33ec933)
- 添加完整的 Base64 编解码工具 (cab5a2c)

### 🐛 问题修复

- 修复 CustomTextInput 快捷键处理问题 (cf1e447)

### 📝 文档更新

- 添加思维链支持文档及模型配置说明 (3607d0d)

### ✅ 测试相关

- 添加大量单元测试和测试工具 (0c9a6ac)


## [0.0.39] - 2025-12-26

### ✨ 新功能

- 优化加载指示器和代码高亮组件 (44c12d1)
- 添加 Blade 命令和技能文档文件 (7b9a092)
- 添加自定义 Slash Commands 系统 (db22092)


## [0.0.38] - 2025-12-25

### ✨ 新功能

- 实现完整的钩子系统与Claude对齐 (dfe8edb)
- 添加 Todo 列表更新回调并发送 ACP plan 更新 (691a651)

### 🐛 问题修复

- 添加操作中止检查并优化中止处理流程 (27596d4)


## [0.0.37] - 2025-12-25

### ✨ 新功能

- 添加原子操作 addAssistantMessageAndClearThinking 避免闪烁 (a7726ed)
- 新增 SkillInstaller 用于首次启动时自动下载官方技能 (2fc2661)

### 🐛 问题修复

- 替换直接process.exit为safeExit确保终端状态恢复 (169af5d)

### ♻️ 代码重构

- 统一主题管理逻辑并优化动态引入 (ead4bd0)


## [0.0.36] - 2025-12-24

### ✨ 新功能

- 实现完整的技能管理系统 (af6f40f)
- 添加 Skills 系统支持动态 Prompt 扩展和工具限制 (f2588b6)


## [0.0.35] - 2025-12-24

### ✨ 新功能

- 添加终端resize时的Static组件刷新功能 (183affb)


## [0.0.34] - 2025-12-24

### ✨ 新功能

- 支持同步 changelog 到外部 blade-doc 仓库 (0e1ea8b)

### 🐛 问题修复

- 解决终端resize残影问题并优化布局 (a1701e1)

### 📝 文档更新

- 更新项目文档链接和问题反馈地址 (064824e)


## [0.0.33] - 2025-12-23

### ✨ 新功能

- 添加历史消息折叠功能及快捷键支持 (5f34b2b)
- 添加图片粘贴和多模态消息处理功能 (a0532a4)

### ♻️ 代码重构

- 合并 isThinking 状态到 isProcessing 并优化处理逻辑 (6e83764)


## [0.0.32] - 2025-12-22

### ✨ 新功能

- 支持 thinking 模型的 reasoning 内容处理 (811c8aa)


## [0.0.31] - 2025-12-22

### ✨ 新功能

- 添加 Agent Client Protocol 支持 (ab1b699)
- 添加 GPT OpenAI Platform 支持及清屏功能 (f48aa42)
- 添加 pre-commit 命令用于 AI 生成 commit message (318bbde)
- enhance WebSearch tool with multi-provider fallback (caf98e7)
- 添加对话轮次限制功能 (fd1879f)
- 重构 MCP 配置管理并支持全局配置 (8fd56ba)
- 添加交互式版本更新提示组件 (5fe01b0)
- 增强模型配置和版本自动升级功能 (0323f54)
- add thinking block UI and model detection, enhance chat features (afb11a3)

### 🐛 问题修复

- 支持带scope的提交消息格式 (a8ad572)

### ♻️ 代码重构

- 统一使用 getUI 发送消息并支持取消信号 (24c401f)

### 🔧 其他更改

- release v0.0.30 (4d0b33d)
- release v0.0.29 (41e0784)
- release v0.0.28 (6be8a21)
- release v0.0.27 (6bf8783)
- release v0.0.26 (77a60d0)
- release v0.0.25 (4742a4b)
- 添加 CHANGELOG.md 到打包文件列表 (91db333)


## [0.0.30] - 2025-12-21

### ✨ 新功能

- 添加 Agent Client Protocol 支持 (ab1b699)
- 添加 GPT OpenAI Platform 支持及清屏功能 (f48aa42)


## [0.0.29] - 2025-12-20

### ✨ 新功能

- 添加 pre-commit 命令用于 AI 生成 commit message (318bbde)
- enhance WebSearch tool with multi-provider fallback (caf98e7)


## [0.0.28] - 2025-12-20

### ✨ 新功能

- 添加对话轮次限制功能 (fd1879f)
- 重构 MCP 配置管理并支持全局配置 (8fd56ba)
- 添加交互式版本更新提示组件 (5fe01b0)


## [0.0.25] - 2025-12-20

### ✨ 新功能

- 增强模型配置和版本自动升级功能 (0323f54)
- add thinking block UI and model detection, enhance chat features (afb11a3)

### 🐛 问题修复

- 支持带scope的提交消息格式 (a8ad572)

### 🔧 其他更改

- 添加 CHANGELOG.md 到打包文件列表 (91db333)


## [0.0.24] - 2025-12-19


## [0.0.23] - 2025-12-18


## [0.0.22] - 2025-12-18


## [0.0.21] - 2025-12-17

### 🔧 其他更改

- add project documentation and build script (a0b903d)


## [0.0.20] - 2025-12-17


## [0.0.19] - 2025-12-17


## [0.0.18] - 2025-12-17

### 📝 文档更新

- 简化README文档结构并更新内容 (796aae7)


## [0.0.17] - 2025-12-16

### ✨ 新功能

- add /git slash command with AI-powered git operations (72526f1)
- 重构状态管理为 Zustand 实现单一数据源架构 (b52d9f2)
- 重构工具系统并添加Plan模式支持 (b9b3bc7)
- 优化孤儿 tool 消息过滤逻辑并添加测试 (cb98b66)
- 将代码中的中文提示信息翻译为英文 (b07f430)
- 添加Subagents系统及相关文档 (6bd6cc9)
- 实现子代理系统及任务工具改进 (b5b8fc1)
- 添加后台命令管理和网络搜索功能 (8d436cb)

### 📝 文档更新

- 全面更新文档内容以匹配当前实现 (9fbd18e)

### 💄 代码格式

- 统一代码格式化和修复缩进问题 (0f11b8a)

### ♻️ 代码重构

- 移除遥测系统及相关代码 (ecc83b3)
- 迁移状态管理至 Zustand 并重构相关组件 (d4b1c30)
- 清理测试配置和工具文档 (58096e1)
- 清理未使用的代码和优化模块结构 (dbca510)

### 🔧 其他更改

- release v0.0.16 (4601d44)
- update pnpm setup in CI workflow (073bf7d)


## [0.0.16] - 2025-12-16

### ✨ 新功能

- add /git slash command with AI-powered git operations (72526f1)
- 重构状态管理为 Zustand 实现单一数据源架构 (b52d9f2)
- 重构工具系统并添加Plan模式支持 (b9b3bc7)
- 优化孤儿 tool 消息过滤逻辑并添加测试 (cb98b66)
- 将代码中的中文提示信息翻译为英文 (b07f430)
- 添加Subagents系统及相关文档 (6bd6cc9)
- 实现子代理系统及任务工具改进 (b5b8fc1)
- 添加后台命令管理和网络搜索功能 (8d436cb)

### 📝 文档更新

- 全面更新文档内容以匹配当前实现 (9fbd18e)

### 💄 代码格式

- 统一代码格式化和修复缩进问题 (0f11b8a)

### ♻️ 代码重构

- 移除遥测系统及相关代码 (ecc83b3)
- 迁移状态管理至 Zustand 并重构相关组件 (d4b1c30)
- 清理测试配置和工具文档 (58096e1)
- 清理未使用的代码和优化模块结构 (dbca510)

### 🔧 其他更改

- update pnpm setup in CI workflow (073bf7d)


## [Unreleased]

### ♻️ 代码重构

- **Grep 工具重大重构 (v3.0.0)**: 实现四级智能降级策略
  - 优先使用系统 ripgrep > vendor ripgrep > @vscode/ripgrep
  - 降级策略: ripgrep → git grep → system grep → JavaScript fallback
  - 将 @vscode/ripgrep 改为可选依赖，减少包体积
  - 使用 picomatch 替代自制 glob 匹配实现
  - 添加 vendor ripgrep 支持（可选，~40-50MB）
- 新增下载脚本: `npm run vendor:ripgrep`
- 完整文档: `docs/development/implementation/grep-tool.md`

### 🧹 移除过时组件

- 删除 `SystemPrompt` 类，统一改为函数式入口 `buildSystemPrompt`（`src/prompts/builder.ts`）。
  - 运行时覆盖：`--system-prompt` 完全替换，`--append-system-prompt` 追加。
  - Plan 模式提示：使用 `PLAN_MODE_SYSTEM_PROMPT`，并通过 `createPlanModeReminder` 注入提醒。
  - 影响范围：旧文档与测试已同步移除类引用，使用统一入口与配置字段。

### 📚 文档

- 整合 Grep 工具相关文档到统一位置
- 新增完整的 Grep 工具实现文档
- 添加 vendor ripgrep 设置指南


## [0.0.15] - 2025-11-10

### 🔧 其他更改

- 更新 ink 依赖至 6.4.0 并同步 pnpm-lock (22405f7)


## [0.0.14] - 2025-11-05


## [0.0.13] - 2025-11-04

### ✨ 新功能

- 实现智能文件提及功能(@提及) (24d426f)

### ♻️ 代码重构

- 移除错误处理和遥测相关代码 (647ae4c)


## [0.0.12] - 2025-11-01

### ♻️ 代码重构

- 重构日志系统并优化文本编辑工具 (4b1a57b)


## [0.0.11] - 2025-10-23

### ✨ 新功能

- 重构为无状态Agent并实现JSONL持久化存储 (9f7f10f)

### 🔧 其他更改

- release v0.0.10 (16cd9ff)


## [0.0.10] - 2025-10-19


## [0.0.9] - 2025-10-14

### ✨ 新功能

- 实现首次使用设置向导和多提供商支持 (5f42000)
- 实现用户确认流程集成与权限系统增强 (1d62c16)
- 添加 TODO 管理工具并规范文件命名 (b5e2a6d)
- add theme command and UI theme selector with enhanced theme system (bd87bdd)

### 🐛 问题修复

- remove main field requirement from release script (e0348ab)

### 📝 文档更新

- 更新README中的命令行使用说明 (f9570fc)
- 更新文档结构和内容，添加英文README (222e35b)

### ♻️ 代码重构

- 移除 Ink UI 组件并更新主题系统\n\n- 移除大量 Ink UI 组件及相关测试文件\n- 更新主题系统，添加语法高亮颜色配置\n- 从 package.json 中移除 main 字段\n- 更新 Claude 安全设置，允许更多 bash 命令 (f77c969)

### 🔧 其他更改

- release v0.0.8 (91b00af)
- release v0.0.7 (e28a010)


## [0.0.8] - 2025-10-12

### ✨ 新功能

- 添加 TODO 管理工具并规范文件命名 (b5e2a6d)


## [0.0.7] - 2025-10-12

### ✨ 新功能

- add theme command and UI theme selector with enhanced theme system (bd87bdd)

### 🐛 问题修复

- remove main field requirement from release script (e0348ab)

### 📝 文档更新

- 更新README中的命令行使用说明 (f9570fc)
- 更新文档结构和内容，添加英文README (222e35b)

### ♻️ 代码重构

- 移除 Ink UI 组件并更新主题系统\n\n- 移除大量 Ink UI 组件及相关测试文件\n- 更新主题系统，添加语法高亮颜色配置\n- 从 package.json 中移除 main 字段\n- 更新 Claude 安全设置，允许更多 bash 命令 (f77c969)


## [0.0.6] - 2025-10-11

### ✨ 新功能

- 添加 Ink UI 组件库集成和现代化界面改进 (8a1fcd9)
- 更新 UI 组件样式和提示文本 (95be248)
- add task abort functionality and improve UI feedback (1f5c4e4)

### ♻️ 代码重构

- 移除 TurnExecutor 类并简化 Agent 实现 (d21a345)


## [0.0.5] - 2025-10-10

### ✨ 新功能

- 迁移命令行工具从commander到yargs (08c2498)

### 🔧 其他更改

- release v0.0.4 (10fb8a2)
- 更新axios依赖至1.12.2，并调整release配置以跳过安全检查 (72dd801)


## [0.0.4] - 2025-10-01

### ✨ 新功能

- 迁移命令行工具从commander到yargs (08c2498)

### 🔧 其他更改

- 更新axios依赖至1.12.2，并调整release配置以跳过安全检查 (72dd801)


## [0.0.3] - 2025-09-30

### ✨ 新功能

- 实现 agentic loop 核心功能 (3fd5693)


## [0.0.2] - 2025-09-29

### 🔧 其他更改

- 临时禁用发布前的代码质量检查和测试 (e46031a)
