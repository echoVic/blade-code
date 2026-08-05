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

真实 API 门禁必须使用当前源码刚构建的 `packages/cli/dist/blade.js`。provider
credential 必须由执行编排器或 secret manager 直接注入测试子进程环境；不要把真实值写成
inline `KEY=value`、执行 `export` 留在 shell history，或复制到证据文档。命令记录只保留
变量名和是否存在，不记录变量值。环境准备完成后执行：

```bash
bun run qualify:production
```

`qualify:production` 在启动任何测试子进程前会 fail-closed 校验：

- `DEEPSEEK_API_KEY` 必须存在；
- `DEEPSEEK_MODELS` 必须同时包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`；
- 未提供 `DEEPSEEK_BASE_URL` 时使用 `https://api.deepseek.com`；
- `DEEPSEEK_MODEL` 默认选择列表中的第一个模型，供单模型轨迹使用；
- 只要存在任一 provider 的显式 API key，环境变量集合就成为完整 allowlist，测试不会再合并 `~/.blade/config.json` 中的个人模型；
- API key 只通过进程环境传递，不写入配置文件、源码、日志或快照。

真实 API 项目覆盖两种模型的生产 CLI 轨迹，包括：

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
或 domestic provider，其配置模型也必须运行四个 production entrypoint；缺少 required Flash/Pro 时
fail closed。API key 只能通过子进程环境变量注入，不写入配置文件、命令记录、日志、
快照或原始请求头。实际命令、模型集合、退出码和复跑事实记录在
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
