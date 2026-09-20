# Changelog

## [0.10.206] - 2026-09-20

### 重构
- 合并 Session 所有权、事件投影、压缩、子代理依赖和本地/远程 fork 处理，拆分 HTTP 路由与回合执行、资源回收职责。
- 删除未使用的内部子系统及过时兼容 API，复用测试夹具生命周期，将静态提示、主题、权限和 SQL 移入随包分发的资源。依赖已删除 `taskTool` 单例的内部集成需改用显式传入 registry 的 `createTaskTool`。

### 修复
- 已获准的逻辑回合完成、失败、取消或关闭时释放 Skill 工具限制；同回合 Plan 批准保留限制，被拒绝的并发请求不改变活动回合状态。
- 保持 Web 待恢复状态可见，并在 Browser 点击后等待弹窗注册完成。
- 取消禁止的跨域导航时保留当前 Browser 页面，为 sandbox frame 检查设置时限，并在快照前读取页面元数据以避免 Chromium 初始化停顿；无法确认的 frame 仍禁止交互。

### 测试
- 保留聚焦的 Runtime 边界套件，以及 CLI、Web、ACP、Browser 工具的生产资格验证路径。
- 真实 Flash/Pro 验证复用 Agent 在下一任务恢复普通工具 schema。
- 覆盖 Headless、ACP、raw PTY、生产/开发 Chromium 的后续任务恢复，验证已停止 Goal 用量不变。

## [0.10.205] - 2026-09-16

### 修复
- 活动 Skill 排除 ToolSearch 时重新投影已获准工具的 schema，使允许的延迟工具仍可调用；保留 Plan 只读过滤、注册表加载状态与结构化输出保留工具。

### 测试
- 覆盖 Skill 激活、限制清除、Plan 模式及结构化输出。
- 真实 Flash/Pro 覆盖 Headless、ACP、raw PTY、生产/开发 Chromium 的 Skill 加载与后续请求精确 schema 校验。

## [0.10.204] - 2026-09-15

### 修复
- 包含未发布的 0.10.203 候选版本中的工具 schema 修复：ToolSearch 不可用时已获准工具仍可调用，保留 Plan 与执行过滤边界。

### 测试
- Browser 测试使用类型正确的目录加载器夹具，使严格 TypeScript 检查通过，不放宽生产工具类型。
- 保留真实 Flash/Pro 直接 schema 调用和跨端编码验证。

## [0.10.203] - 2026-09-15

未发布候选版本。CI 拒绝了 Browser 测试夹具的泛型类型；其运行时改动与修正后的夹具一起包含在 0.10.204 中。

### 修复
- ToolSearch 不可用时直接暴露已获准工具的完整 schema，避免显式工具过滤使延迟工具无法调用；保留 Plan 只读投影、执行过滤，以及加载器可用时的按需加载。

### 测试
- 覆盖加载器移除与恢复、动态 MCP 替换、Runtime 白名单和黑名单边界。
- 真实 Flash/Pro 覆盖 Headless、ACP、raw PTY、生产/开发 Chromium 的直接 schema 调用，校验精确请求工具集合和逐响应文本交付。

## [0.10.202] - 2026-09-15

### 修复
- Goal 转为 blocked 后仍结算身份匹配的在途回合已返回用量，保留阻塞原因与恢复证据；继续校验 Goal/回合归属，超预算恢复不再发起请求。

### 测试
- 使用真实 store 覆盖阻塞用量边界和缺失、过期的 Goal/回合身份。
- 真实 Flash/Pro 覆盖 Headless、ACP、raw PTY、生产/开发 Chromium 的暂停和阻塞计量，包括 ToolSearch 延迟加载与轮次上限结算。

## [0.10.201] - 2026-09-15

### 修复
- 空文本工具响应不再清除待完成的 TUI 流式收尾标记，避免后续工具结果和本地命令消息被 Ink 静态输出队列跳过。

### 测试
- 使用真实 Ink 渲染与会话 store 复现丢消息顺序，同时检查两个工具结果及后续状态消息。

## [0.10.200] - 2026-09-15

### 修复
- stdin 或 stdout 重定向时，首次 SIGINT 直接协调关闭，不向 ACP 和服务输出写入交互式双击提示；完整 TTY 保留双击退出，Headless 继续使用独立信号生命周期。

### 测试
- 覆盖 stdin/stdout 的全部 TTY 组合，以及真实 Flash/Pro 在 Headless、ACP、raw PTY、Web 下的 SIGTERM/SIGINT 退出与恢复，验证 TUI 首次信号不退出和 ACP 原始 JSON 流完整性。

## [0.10.199] - 2026-09-15

### 修复
- 协调关闭时仅向 TTY stdout 输出终端复位序列，避免 ANSI 控制码污染重定向输出和 ACP JSON 流；保留 stdin raw mode 恢复、清理顺序与关闭预算。

### 测试
- 覆盖重定向输出下的 SIGTERM 与正常关闭、交互终端复位，以及真实 Flash/Pro 在 Headless、ACP、raw PTY、Web 的退出与恢复。
- 对 SIGTERM 期间原始 ACP stdout 校验 JSON 格式，不再仅检查已解析通知。

## [0.10.198] - 2026-09-15

### 修复
- 显式暂停 Goal 后，身份匹配的在途回合仍结算已返回用量，保留暂停状态、原因与恢复证据；拒绝缺少身份、目标编辑或替换后的过期结算。
- Goal 在当前回合内创建时也携带宿主回合身份；暂停期间结算耗尽预算后，显式恢复会停在 `budget_limited`，不再发起模型请求。

### 测试
- 使用真实 store 覆盖 active/verifying 暂停结算、身份拒绝、重启持久化与预算边界。
- 使用真实 DeepSeek Flash/Pro 覆盖 Headless、ACP、raw PTY、生产/开发 Chromium，以及发起回合内创建后暂停。

## [0.10.197] - 2026-09-15

### 修复
- 自动压缩用量标记为 auxiliary，TUI/Web 累计摘要消耗而不覆盖主请求上下文读数；压缩失败或取消不再清零上下文，成功提交后仍清零旧读数。
- Headless JSONL 保留辅助用量标记，不改变循环和 Goal 的 token 累计。

### 测试
- 使用真实 store 覆盖成功、降级和失败压缩，并验证三个循环入口及 Headless 的用量标记传播。
- 使用真实 Flash/Pro 在生产/开发 Chromium 与 raw PTY 验证取消后的上下文读数保留、摘要用量交付及无压缩 checkpoint。

## [0.10.196] - 2026-09-15

### 修复
- 包含未发布的 0.10.195 候选版本中准备的自动压缩 Session 渠道隔离修复。
- 提取公开压缩摘要前先移除开头的分析段，避免分析中引用的 summary 标签导致分析内容进入替换上下文；只有分析或分析未闭合时沿用空摘要有界重试，并保留已返回用量。

### 测试
- 覆盖分析中的字面量与成对 summary 标签、分析后的纯文本摘要，以及缺少公开摘要时的有界降级。
- 验证真实工作区渠道续传保留当前请求，且压缩摘要不含分析分隔标签。

## [0.10.195] - 2026-09-15

未发布候选版本。其改动与资格验证中发现的摘要解析修复一并包含在 0.10.196 中。

### 修复
- 阈值、反应式和轮次上限压缩保留 Session 自有的模型目录、渠道请求头、认证及端点，不改变摘要采样预算。

### 测试
- 覆盖三个自动压缩入口的渠道传播；通过真实并发工作区验证上下文超限恢复期间端点与请求头始终隔离。
- 为跨进程工作区引用容量测试保留有界子进程阶段诊断，不增加超时预算。

## [0.10.194] - 2026-09-15

### 修复
- ACP 手动压缩使用所属 Session 选择的模型、上下文窗口、认证、端点与模型目录，而不是全局默认配置；保留渠道请求头，摘要采样预算保持独立。

### 测试
- 验证 Session 模型边界失败时不回退全局配置，摘要重试、超时、输出及温度限制不变。
- 使用两个真实 Pro ACP 渠道验证隔离：两个 Session 各向自己的端点发送一次摘要请求，全局默认渠道零请求。

## [0.10.193] - 2026-09-15

### 修复
- 手动 `/compact` 传递 TUI/ACP 取消信号；在 checkpoint 持久化前观察到取消时，不替换上下文或提交项目记忆。取消仍保留已返回用量，TUI 不清零上下文读数；已经提交的 checkpoint 不回滚。

### 测试
- 覆盖调用前取消、采样中取消、持久化前取消、checkpoint 已提交的竞态，以及 TUI 只累计用量的处理。
- 使用真实 DeepSeek Flash/Pro 验证 ACP 与 raw PTY 手动压缩取消，检查 Provider 连接关闭、会话记录不变及 TUI 输入恢复。

## [0.10.192] - 2026-09-15

### 修复
- 压缩在重试等待、后续采样或摘要后处理阶段取消时，保留此前已返回的累计用量；阈值、反应式和轮次上限三个循环入口仅计量一次，并保留 Goal 预算累计，不生成降级 checkpoint 或增加熔断失败次数。

### 测试
- 覆盖取消用量传播、原始异常 cause、熔断隔离及三个循环入口。
- 使用真实 DeepSeek Flash/Pro 验证压缩采样中途取消时 Provider 总量、循环用量事件、回合结果及 Goal 冷读取一致，且无压缩 checkpoint 或后续 Provider 重放。

## [0.10.191] - 2026-09-14

### 修复
- TUI 已完成或失败的旁路面板优先响应 Esc 关闭，避免误触主任务取消或草稿处理；保留主输入草稿、焦点归属、翻页及加载态取消行为，并显示关闭快捷键。

### 测试
- 使用真实 DeepSeek Flash/Pro 验证短/长答案关闭后草稿保留，包含主 Bash 仍运行时先关闭旁路，再由下一次 Esc 明确取消主任务。
- PTY 关闭取证使用最新完整重绘，而非累计旧面板文本；保留半帧和仍可见面板的拒绝断言。

## [0.10.190] - 2026-09-14

### 修复
- Bun 下禁用 Provider fetch 连接复用，避免复用连接丢失响应时静默重发 POST；Node 请求选项保持不变，重试次数与事件仍由 Blade 控制。

### 测试
- 通过真实 HTTP 断流验证 Bun 零次/一次重试，以及已有部分输出后失败而不重放；验证请求头、正文、取消信号和 Node 选项保持不变。
- worktree 测试使用已提交的只读种子生成独立目录副本，保留提交 hooks 与隔离检查，减少重复夹具初始化，不改变套件时间预算。

## [0.10.189] - 2026-09-14

### 修复
- TUI 旁路答案和错误信息使用随终端大小限高的 Markdown 滚动区域；PgUp/PgDn 翻页不修改主输入草稿，遵循弹窗/历史焦点，在内容边界停止，并在新问题开始时回到顶部。

### 测试
- 覆盖滚动边界、视口变化、普通按键透传、加载/关闭及新问题重置。
- 使用真实 DeepSeek Flash/Pro 在 raw PTY 验证长答案每一行可读、缩放后首尾可达，且主输入草稿、上下文读数、取消和持久化记录保持不变。
- 跨界面改码夹具明确要求使用 Edit/Write，与既有校验器对齐，并记录持久化工具与页面卡片的结构证据，不改变断言或重试预算。

## [0.10.188] - 2026-09-14

### 修复
- TUI 旁路长问题或多行问题的头部采用单行省略展示，完整 Provider 请求不变，缩窄终端后短答案和主输入区仍保持可见。

### 测试
- 覆盖加载、完成和失败状态的头部展示，验证原始问题不被修改。
- 使用真实 DeepSeek Flash/Pro 验证 150x48 与 100x36 PTY 中长问题答案、输入区和上下文读数同屏且高度有界，并核对 Provider 收到完整问题。

## [0.10.187] - 2026-09-14

### 修复
- `/btw` 回复返回时不再覆盖 TUI 和 Web 的主上下文读数；旁路仍累计 Token、缓存及费用，不会替换更新后的主回合读数或恢复压缩后已清零的上下文。

### 测试
- 覆盖旁路用量累计、主回合更新或上下文清零后的延迟旁路回复，以及 TUI 命令路由。
- 使用真实 DeepSeek Flash/Pro 验证生产/开发 Chromium 和 raw PTY 的主上下文读数稳定，保留旁路取消、ACP 恢复、记录隔离及输入法断言。

## [0.10.186] - 2026-09-14

### 修复
- 压缩因空回复耗尽、后续采样错误或后处理失败而降级时，保留已返回的摘要用量，包括 Token、推理、缓存及费用总量，不改变重试和取消语义。

### 测试
- 用确定性回归覆盖全部采样失败分类及摘要后的文件恢复失败。
- 使用真实 DeepSeek Flash/Pro 验证摘要成功、stop sequence 触发的空摘要耗尽，以及用量交付后正常结束/取消，与 Provider 总量、循环事件、结果及冷读取 Goal 预算逐项对齐。

## [0.10.185] - 2026-09-14

### 修复
- 将已返回的压缩用量计入循环总量和 Goal 预算；阈值压缩、反应式压缩及轮次上限摘要请求与用量事件使用相同规范化计数。
- 取消、Provider 或持久化失败以及工具提前退出时保留已消耗 Token，不改变上下文阈值、重试限制或输出恢复预算。

### 测试
- 覆盖压缩成功/降级、失败及取消、终态持久化路径和总量规范化。
- 使用真实 DeepSeek Flash/Pro 验证压缩与取消后的循环用量事件、结果总量及冷读取 Goal 预算一致，并确认预算耗尽后不再续跑。

## [0.10.184] - 2026-09-14

### 测试
- 通过生产/开发 Chromium、raw PTY TUI 和 ACP 验证真实 DeepSeek Flash/Pro 跨模块迁移，要求两个源码文件实际修改、测试及 package.json 不变、验证命令成功，并由宿主独立检查产物行为。
- 将 GUI 可见卡片和 ACP 工具终态更新与持久化 tool-call ID 对齐；按结果提交顺序而非调用顺序验收，等待 Web 历史同步，保留精确命令和最终回复断言。
- 复用现有受控 benchmark 夹具；八格集成验收不代表大型仓库基准或原生桌面 Computer Use 覆盖。

## [0.10.183] - 2026-09-14

### 修复
- 测试命令运行器在取消信号已触发时不再启动子进程或 owner watchdog，已取消的构建/测试阶段不会继续执行命令。

### 测试
- 通过真实子进程复现预取消后仍写文件的问题，修复后验证零启动；保留运行中取消、超时和 owner 退出的进程树回收检查，不改变预算。

## [0.10.182] - 2026-09-14

### 修复
- 用宿主验证的受控代码任务替换 benchmark 关键词式成功判定；每项任务使用独立临时项目与会话环境，不再修改调用方仓库。
- 要求精确改动范围、成功工具证据、最后修改后的测试，以及宿主独立校验的源码行为；累计所有请求用量，只记录源码摘要和校验结果，不保存模型正文或凭据。
- `controlled-coding-v2` 分数与旧历史分开存储，任一用例失败则命令非零退出；固定小型任务不代表真实大型仓库能力，也不是 OS 安全沙箱。

### 测试
- 拒绝未修改代码的成功声明、篡改测试、符号链接、新增目录、提前运行的测试、篡改断言库及提前成功退出，并限制不返回的验证进程。
- 使用真实 DeepSeek Flash/Pro 完成诊断、单文件修复与跨模块迁移，验证调用方文件不变，并要求六格全部通过宿主校验。
- PTY 测试在原有完成预算内等待精确回复持久化完成后再终止进程，保留结构诊断，不再只依赖屏幕文本。

## [0.10.181] - 2026-09-13

### 修复
- 没有成功工具结果时，普通终态的空正文或纯空白回复明确失败，不再标记回合完成；只有推理不算答案，也不额外增加 Provider 请求。
- 保持已有工具成功后的纠正、结构化输出完成、长度恢复、取消和待处理输入语义不变。

### 测试
- 覆盖流式/非流式、无工具/工具失败后的空回复，确认没有纠正请求或成功完成回执。
- 使用真实 DeepSeek Flash/Pro stop sequence 在 Headless、ACP、raw PTY TUI 和 Chromium 验证可见失败及同会话后续替换请求：恰好两次 Provider 请求、零工具调用；PTY 答案标记拆分，避免输入回显误判为完成。

## [0.10.180] - 2026-09-13

### 修复
- Web 取消收尾或历史同步替换流式消息身份时，保留已展开的工具组与详情；展开状态仅存于当前会话界面，尊重主动折叠，并清理已移除工具的记录。
- 同一工具调用的实时与持久化时间线引用合并为一张卡片，保留最新结果，不修改原始消息数据。

### 测试
- 覆盖历史替换、临时加载、主动折叠、工具移除、会话隔离及实时/持久化重复工具投影。
- 使用真实 DeepSeek Flash/Pro 和生产、开发 Chromium 验证取消交互：仅一张 Bash 卡片、错误详情保持展开、精确追问回复、命令不重放、零浏览器错误；仅去重而不保留展开状态的对照构建正确失败。

## [0.10.179] - 2026-09-13

### 修复
- 取消发生在工具执行、后置钩子、LSP 同步或自动验证期间时，保留工具已明确报告的清理失败，不再用普通取消覆盖原错误和清理元数据；回合仍按取消结束。
- 保持普通取消、待处理输入恢复、进程清理预算及命令重放行为不变。

### 测试
- 覆盖四个取消检查点，并拒绝 false、字符串、原型继承、缺失及成功结果中的清理失败标记。
- 使用真实 DeepSeek Flash/Pro 验证取消期间 ACP kill/release 失败，以及 Chromium 停止操作后的本地 lease 清理失败：错误持久化、同会话追问、Bash 不重复执行；追问完成后验证刷新历史，并等待取消后的历史同步再操作错误卡片。
- 压缩资格测试按当前请求分类，不再匹配历史引用中的提示词；Web 必须持久化精确回复，并保留有界 Provider 响应摘要，防止仅有推理或附带额外正文的回复被误判为完成。

## [0.10.178] - 2026-09-13

### 修复
- ACP 终端请求预先取消时不再发送 terminal/create；创建请求进行中取消后若创建失败，保留取消分类，不进入本地回退，也不暴露客户端创建错误。
- 保持迟到句柄的清理屏障与清理失败分类；创建中取消仍等待客户端响应后，再回收已取得的终端。

### 测试
- 通过配对 ACP SDK 覆盖预取消零创建、开启或关闭回退时的创建拒绝、迟到句柄清理和后续执行。
- 使用真实 DeepSeek Flash/Pro 与生产 ACP 验证创建拒绝或延迟期间取消：恰好一次终端请求、客户端资源释放、规范取消历史，以及同一会话恢复且命令不重放。

## [0.10.177] - 2026-09-13

### 修复
- 侧边对话完成或报错时不再从其他编辑器抢走焦点；取消过期的延迟聚焦回调，并尊重回调执行前用户主动切换的焦点。

### 测试
- 通过可控动画帧和生产 Chromium 复现焦点抢占；使用真实 DeepSeek Flash/Pro 在生产、开发 GUI 验证主输入框焦点与草稿保留，并核对准备失败后从浏览器到 Provider 的精确问题。

## [0.10.176] - 2026-09-13

### 修复
- ACP 客户端 terminal kill/release 失败时明确报告清理失败，不再误报成功或仅报告超时/取消；保留最终输出与停止原因，不重放命令、不本地回退、不泄露原始客户端错误。
- ACP 后台任务在清理完成前保持运行状态，合并并发终止与 Session 清理，TaskOutput 和 KillShell 明确反映清理失败。

### 测试
- 新增清理拒绝、阻塞清理、并发及重复终止、后台状态、禁止本地回退及恢复的协议回归。
- 使用真实 DeepSeek Flash/Pro 和生产 ACP stdio 验证客户端拒绝 kill/release：恰好一次失败工具更新、持久化失败元数据、命令不重放。
- 记录有界 Provider 响应摘要，区分有持久化证据的一次空回复纠正与请求重放；通过 Headless、ACP、raw PTY TUI 和 Chromium 验证真实空回复恢复，Bash 不重复执行。
- 确定性压缩测试等待 PTY 实际观察到压缩状态后才释放摘要响应，并跨重绘保留观察结果，避免短暂状态造成竞态。

## [0.10.175] - 2026-09-13

### 测试
- 禁用真实 Chromium 测试页面的滚动边界回弹，避免滚轮输入后的合成器视口位移干扰坐标授权验证；精确截图校验、跨 frame 拒绝和页面变化拒绝断言保持不变。

## [0.10.174] - 2026-09-13

### 修复
- 本地 Bash 与 ACP 本地终端在超时或取消后发生收尾失败时优先报告 finalization，包括交接前的受管前台候选；保留原停止标记和未清理 lease，不再只报告普通超时或取消。
- 保留有界输出统计和规范收尾失败分类，不暴露原始清理错误，不改变重试或进程终止预算。

### 测试
- 通过目录权限复现直接 Bash、受管前台和 ACP 本地路径的真实 lease 删除失败，覆盖取消/异常顺序、lease 保留及后续命令成功。
- 使用真实 DeepSeek Flash/Pro 和 Chromium 验证实际 Bash 超时后 lease 删除失败的 Provider 请求、持久化工具结果、错误卡片及刷新恢复。

## [0.10.173] - 2026-09-13

### 修复
- Web 侧边对话草稿绑定会话、工作区和请求；关闭或替换面板不再带入未发送文本，已取消请求的迟到失败不会覆盖新草稿。
- 保留当前面板的失败与校验恢复，并区分同一毫秒内新建的面板。

### 测试
- 新增先失败后修复的草稿归属回归与生产 Chromium 旧版本对照；通过真实 DeepSeek Flash/Pro 验证请求替换、有界取消、精确后续回答、主 JSONL 不变，以及生产/开发 GUI 的草稿清除。

## [0.10.172] - 2026-09-13

### 修复
- 侧问请求中的历史用户文本显式标记为主对话引用，不再仅靠系统提示区分未完成主任务与当前侧问；转义引用分隔符，保留原角色、图片、元数据和父会话持久化记录。

### 测试
- 覆盖纯文本、多模态历史、分隔符转义及父数据不变；断言实际 Provider 的历史引用边界，保留原始冲突主任务和精确后续答案检查。

## [0.10.171] - 2026-09-12

### 修复
- 为侧边提问增加静态系统级作用范围：历史仅供参考，只回答最后的用户问题，不继续未回答或已取消的主任务；不把用户问题和历史正文提升为系统指令。

### 测试
- 覆盖新建及持久化根提示、父上下文不变，并断言真实 Provider 消息边界，保留冲突主任务指令和精确后续答案。
- 动态 MCP 测试服务在 stdin EOF 时释放文件监听，包括目录刷新被阻塞的情况，不再依赖 SDK 延迟终止兜底；生产取消期限不变。

## [0.10.170] - 2026-09-12

### 修复
- Web 主输入框、侧边对话和批注编辑器不再拦截输入法组合按键：选词确认不误发未完成草稿，Escape 不误关编辑器，方向键不误切输入历史。
- 组合结束、失焦和重新打开编辑器时清除组合状态，保留明确提交、多行输入和全选操作。

### 测试
- 新增先失败后修复的输入法回归，并在生产和开发 GUI 中通过真实 Chromium 组合输入及 DeepSeek Flash/Pro 验证：无提前 HTTP 请求、回答精确、侧边提问不改主 JSONL、批注仅留本地草稿、零浏览器错误。

## [0.10.169] - 2026-09-12

### 修复
- TUI 自动续跑超时后仍持有旧尝试，直到其收尾完成；期间合并新唤醒，新的恢复周期仍需通过前台空闲检查。
- 保留 deadline 到达时立即取消和一次终态错误报告，不改变重试预算，没有新唤醒时不重启已耗尽的任务。

### 测试
- 覆盖迟到成功/失败、收尾期间卸载、无新唤醒、前台所有权及 deadline 回调重入。
- 使用真实 DeepSeek Flash/Pro Hook/Runtime 和原有 120 秒期限，验证阻塞初始化期间只有一个命令所有者，收尾后仅执行一次持久化回合。
- 侧边面板关闭断言改为检查完整 Ink 重绘帧，而非累积终端历史；覆盖可选光标定位和分块帧边界，不放宽三秒取消期限。

## [0.10.168] - 2026-09-12

### 修复
- TUI 旧自动续跑释放命令所有权时通知当前协调器，避免切换后的会话丢失已保留的唤醒；保留新命令接管和无待处理工作的保护。

### 测试
- 覆盖初始化及流执行期间的会话/工作区切换、新命令接管和空闲目标会话。
- 使用真实 DeepSeek Flash/Pro Hook/Runtime 与受控初始化验证交接：仅新会话请求进入 Provider，指令恰好完成一次，旧持久化指令仍保留。

## [0.10.167] - 2026-09-12

### 修复
- 侧边对话的并行预处理任一失败后，等待两项操作全部结束再释放 Runtime 所有权；保留首个异常，成功路径仍并行执行。

### 测试
- 覆盖上下文/提示构建失败、迟到失败、资源释放屏障及两种成功完成顺序。
- 使用真实 DeepSeek Flash/Pro Chromium 验证损坏上下文与 FIFO 内存读取并存时不会提前返回，失败操作不调用 Provider，恢复后可继续提问。

## [0.10.166] - 2026-09-12

### 修复
- TUI 的 Esc 取消目标从侧边提问切换到仍在运行的主任务，或切换到替换后的侧边请求时，重新允许取消；保留同一目标的重复取消抑制。

### 测试
- 新增真实 React 重渲染回归，覆盖取消所有权切换及忙碌阶段对照。
- 在生产 raw PTY 复现第二次 Esc 丢失，再使用 DeepSeek Flash/Pro 验证终端取消、主工具清理及后续侧边提问；补充真实 ACP stdio 取消，精确校验协议文本及主 JSONL 不变。

## [0.10.165] - 2026-09-12

### 修复
- 主循环和侧边提问在等待 MCP 目录刷新时可立即取消，不中止共享刷新；等待结束后移除监听，并接收取消后迟到的刷新失败。
- 侧边提问在准备前及上下文准备期间取消后，不再进入 Provider；上下文读取结束前仍保留 Runtime 所有权。

### 测试
- 覆盖预先取消、等待者隔离、成功/失败监听清理、迟到拒绝、Runtime 释放及主循环中断。
- 使用真实 MCP stdio 与 DeepSeek Flash/Pro Chromium 验证关闭面板、服务器关闭和停止主轮次，断言有界取消、精确后续回答、持久化中断及零重试。

## [0.10.164] - 2026-09-12

### 修复
- Web 服务器开始关闭时立即取消进行中的侧边提问，不再先等待请求结束再释放 Runtime；保留客户端关闭面板、初始化期间取消及请求完成后的监听清理。
- 主任务仍由服务器持有，不因提交请求的客户端断连而停止；侧边对话继续与主会话记录隔离。

### 测试
- 覆盖侧边提问的关闭、已删除 worktree 回退、客户端取消、初始化、监听释放及主任务所有权边界。
- 新增真实 DeepSeek Flash/Pro Chromium 关闭面板与服务器关闭轨迹，验证三秒内取消、正常停止日志、精确后续回答、JSONL 不变及框架和模型零重试。

## [0.10.163] - 2026-09-12

### 测试
- 未启用付费测试时，setup 不再加载 real-api 凭据配置、模型目录和应用 store；隔离存储初始化与清理保持不变。
- 本地免凭据 real-api 文件在现有四 worker 上限内使用隔离进程并行加载；付费矩阵和 CI 仍串行，测试集合、重试规则及进程预算不变。
- 删除已不受支持的 `minWorkers` 配置，新增调度、导入边界和调用方存储目录回归；保留真实 DeepSeek Flash/Pro × Headless、ACP、raw PTY、Chromium 验证，不宣称修复 Node 原生工作线程崩溃。

## [0.10.162] - 2026-09-11

### 测试
- Web 回合活动验证在重连快照断言完成后才释放工具；两个独立 SSE 读取器均收到合法终态清除后才收集证据，不再把浏览器活动条消失当作探针已收到事件的证明。
- 新增延迟读取及变异验证回归，保留精确终答、请求数量和零重试的 DeepSeek Flash/Pro × Headless、ACP、raw PTY、Chromium 矩阵。

## [0.10.161] - 2026-09-11

### 新功能
- Web 对话记录新增选中文字操作，支持结构化注释和临时多轮侧边对话。
- 选中内容在主输入框中显示为可移除的注释胶囊，发送后显示为可展开的引用上下文。

### 修复
- 选中内容不再写入输入框正文，仅作为不可信引用 metadata 注入 Provider 上下文。
- 侧边对话与主会话记录隔离；任务 worktree 删除后回退到源项目，无可用回退目录时返回明确错误。
- 将同一轮模型循环产生的连续 assistant 消息折叠为一个展示响应，命令组与思考块按正文阶段收拢，不再堆叠在底部。
- 主输入框、注释编辑器和侧边对话输入框均支持 Ctrl/Cmd+A 全选。
- 输入法组合期间保持任务切换器的键盘选择，结果在静止鼠标下移动时也不会抢走高亮。

### 测试
- 新增注释、侧边对话、时间线收拢和任务切换器输入法行为的组件、Store、路由、Provider 上下文及生产 Chromium 覆盖。

## [0.10.160] - 2026-09-11

### 修复
- 打开的 TUI resume/fork 选择器跟随完整任务目录刷新，不再出现未读标记已更新、已完成任务仍显示运行中的情况；加载中或失败时保留上一次完整列表，后台更新不会重新打开已关闭的选择器。
- 元数据变化、插入、重排及跨页更新时按完整本地或远程 locator 保留高亮；继续支持分页快捷键、页内移动、数字选择与激活锁，空列表不执行会话选择。
- 在渲染提交前校正选择身份，避免延迟 effect 覆盖下一次键盘操作。

### 测试
- 新增 failing-first 目录、身份及分页回归，并验证空列表、远程身份和快速按键边界。
- 分别使用真实 DeepSeek Flash/Pro raw PTY 验证离线完成恢复与选择器打开期间完成任务，保留远程历史、生产 Chromium 和开发 GUI 检查，框架及模型均不重试。

## [0.10.159] - 2026-09-11

### 修复
- Web 任务切换器在后台任务插入、审批请求或状态变化触发实时重排时，按完整工作区与会话身份保留高亮；Enter 不再误开移动到旧下标的任务。
- 高亮任务消失时选择首个剩余结果，搜索、切换模式及重新打开时重置选择，空结果下 Enter 不执行选择。

### 测试
- 新增 failing-first 组件回归，覆盖跨项目身份、实时重排、完成及移除，并验证搜索、空结果、首尾循环和重新打开。
- 在生产 Chromium 复现旧行为失败，再使用真实 DeepSeek Flash/Pro 后台任务及既有 raw PTY 任务注意力轨迹验证修复；开发 GUI 覆盖实时插入、跨页面归档和精确键盘选择。

## [0.10.158] - 2026-09-11

### 修复
- 修复 macOS/Bun 将原子发布文件解析为同目录硬链接名称时，ACP 工作区引用偶发被拒绝的问题；仅在重新核对设备、inode、所有者及私有权限与原文件身份一致后接受别名。
- 目录路径仍严格校验，继续拒绝跨目录别名、不同 inode、符号链接及文件替换，不赋予远程只读历史任何执行权限。

### 测试
- 新增七项确定性硬链接回归，覆盖发布、持久化读取及非法别名，并在并发测试环境中验证修复。
- 使用 DeepSeek Flash/Pro 验证 ACP 历史的 Chromium 与真实 Ink 输入流程，另行验证 Node/Bun raw PTY 启动与生命周期；长路径显示断言适配终端换行，同时保留远程工作区路径的精确校验。

## [0.10.157] - 2026-09-10

### 修复
- 修正已提交 Web 时间线文件的格式问题，使发布通过格式门禁。v0.10.156 已打标签但因该门禁失败未发布，原标签保持不变。
- 发布下方记录的技能目录按需加载与时间线展示优化，不包含共享工作区尚未提交的聊天选区改动。

## [0.10.156] - 2026-09-10

该标签未发布到 npm；这些变更由 v0.10.157 发布。

### 修复
- 仅在安装弹窗打开且处于「目录」页时请求远端技能目录；查看、刷新、启用或卸载已安装技能不再提前访问 GitHub。
- 目录错误与重试入口保持可见，不阻止仓库或本地安装；返回「目录」页会重新加载，关闭弹窗或停留在「仓库」「本地」页不会新发目录请求。

### 变更
- 包含此前已提交的 Web 时间线展示优化：按阶段合并思考块和工具组，保留助手正文边界及存储中的原始事件顺序。

### 测试
- 新增 failing-first 设置页回归，覆盖按需加载、切换页签、重试和目录失败后的本地安装。
- 在真实 Chromium 中验证 GitHub 返回 403 时的可见错误、显式重试、本地安装与卸载，并保留 raw PTY 生命周期及 DeepSeek Flash/Pro 真实内置技能调用验证。

## [0.10.155] - 2026-09-10

### 修复
- Runtime 纠正、Stop hook 与续跑控制提示仍进入模型上下文，但不再作为用户消息显示在 CLI/TUI、Web 或 ACP 会话记录中；保留控制元数据及 assistant 先于纠正消息的持久化顺序。
- Markdown 导出排除明确标记隐藏的消息及其附属内容，启用 reasoning 也不暴露；用户自己输入相同文字仍正常显示，不自动改写或按内容猜测未标记的历史记录。
- 纠正用户明确要求的单一工具且没有成功结果时，要求下一回合使用原生调用，不接受再次承诺执行却报告完成；保留权限检查、用户改向和输出预算失败语义，绝不直接执行文本参数。

### 测试
- 新增 failing-first 可见性与导出回归，并扩展 DeepSeek Flash/Pro 的 Headless、ACP 重载、raw PTY 重启及 Chromium 重载验证。
- 文本工具调用纠正测试仅将首轮显式构造为真实 Provider 的 JSON 生成请求，记录受约束请求序号并保留原始请求；响应原样透传，后续生产恢复请求不改写，不将该测试构造视为自然首轮响应的验证。

## [0.10.154] - 2026-09-10

### 修复
- 在所有恢复续跑前统一检查显式模型回合上限，覆盖输出截断、未完成意图、结构化输出、验证、委派、空回复、Stop hook 和中途输入；最后一个允许回合仍可正常完成。
- 等待 TUI 回合上限选择期间取消时，不再开始压缩；保留显式继续、检查点持久化及回合计数重置语义。
- 回合预算耗尽后确认消费已处理输入，防止 Web 重载或进程恢复静默重放、把失败任务改成已完成；尚未消费的后续输入仍保留。

### 测试
- 新增 failing-first 预算与取消回归，覆盖流式、排队输入、交互续跑和终态输入确认消费。
- 使用 DeepSeek Flash/Pro 验证 Headless、ACP、raw PTY 和 Chromium：预算耗尽时严格只有一次模型请求，TUI 选择停止后结束，Web 重载后仍保留失败且不重放输入。

## [0.10.153] - 2026-09-10

### 修复
- 用户明确要求调用当前可用工具、模型却只返回工具调用 JSON 文本时，Runtime 会要求改用原生工具调用，或根据已有结果给出最终答复；每次循环调用最多纠正两次，绝不把文本直接转成可执行工具调用。
- 纠正预算或回合上限耗尽时明确失败，输出长度恢复耗尽也不再误报成功；普通 JSON 示例、引用请求、结构化输出契约、不可用工具和权限检查保持原有路径。

### 测试
- 新增 failing-first 回归，覆盖纠正、重复无效回复、输出与回合预算、流式、取消、持久化失败、权限拒绝及正常 JSON 回答。
- 使用 DeepSeek Flash/Pro 验证 Headless、ACP、raw PTY 和 Chromium：真实模型先产生调用 JSON 文本，再经一次宿主纠正和一次原生 Read 完成任务，并校验持久化记录、内部控制消息隐藏、Web 完成状态和重载行为。

## [0.10.152] - 2026-09-09

### 修复
- Skill 安装使用参数数组调用 Git，不再拼接 shell 命令；显式或推导出的技能名均在调用 Git、改动文件前校验。
- 仓库来源只接受 HTTPS 或 SSH，拒绝内嵌凭据、查询参数和片段；HTTP 入口对非法安装请求返回 400。
- 本地安装在替换前拒绝源、目标目录重叠，覆盖符号链接父目录和大小写别名；保留正常链接、复制和重复安装行为。

### 测试
- 新增 failing-first 回归，覆盖命令及选项注入输入、目录越界、源文件保护、路径重叠、名称推导和 HTTP 校验。
- 使用真实 Git 克隆验证 shell 特殊字符保持字面值，并在 Chromium 验证非法安装提示后仍可正常安装、卸载且保留源文件。

## [0.10.151] - 2026-09-09

### 修复
- 工作区初始化和刷新只加载随包内置及本地已有的 Skills，不再隐式下载默认技能；全新 CLI/TUI、Web 和 ACP 会话无需等待 GitHub clone 即可使用内置能力，显式安装入口保持可用。
- 发现本地安装创建的技能目录符号链接，保留用户覆盖；卸载覆盖版本后恢复内置内容，不删除链接指向的源文件。

### 测试
- 新增 failing-first 回归，覆盖无下载初始化与刷新、内置内容、本地覆盖、符号链接安装、失效链接和源文件保留，并移除工作区及信任测试中过时的安装器 mock。
- 验证真实 Chromium 内置技能展示、显式本地安装与卸载回退，以及未预装技能、无 GitHub 下载请求的全新 HOME Node/Bun raw PTY 启动。
- 验证 DeepSeek Flash/Pro 在空技能目录中真实调用内置 Skill，并保留真实工作区与 ACP 资源隔离轨迹。

## [0.10.150] - 2026-09-09

### 修复
- TUI 启动不再等待版本查询网络请求：有效本地缓存用于更新提示，缺失或过期缓存在后台刷新，供下次启动使用；显式 `blade update` 仍实时查询 registry。
- 合并并发启动刷新，保留网络等待期间保存的跳过版本设置，并在写入缓存前校验 registry 版本数据。
- 版本查询的截止时间覆盖响应正文读取；成功、失败或取消时回收代理资源，提前返回时取消未读取的正文。

### 测试
- 新增 failing-first 回归，覆盖非阻塞启动、刷新去重、缓存与跳过设置、正文截止时间、取消及代理清理，并增加真实 HTTP 正文生命周期测试。
- 使用 Node 和 Bun 的 raw PTY 验证 registry 连接仍阻塞时即可进入界面，以及请求自动回收、缓存更新提示和 Skip，并保留 Chromium 生命周期验证；预装默认 Skills 以隔离版本检查路径。

## [0.10.149] - 2026-09-09

### 修复
- Web 全局事件流首次握手成功时也对账任务与 Surface 目录，补回初始目录加载到订阅就绪之间创建的任务，无需刷新页面。
- 重复连接通知保持幂等；订阅者卸载后忽略晚到的连接回调，不改变当前会话，也不把离线状态错误恢复为在线。

### 测试
- 修复前用真实 Chromium 复现首次握手丢失窗口，修复后验证自动恢复，并保留跨页面生命周期操作及 raw PTY 的 owner 状态检查。
- 新增首次握手、重复通知与卸载后晚到回调的回归；DeepSeek Flash/Pro 真实 API 轨迹同时覆盖延迟真实 SSE 握手与独立持续在线观察页。

## [0.10.148] - 2026-09-09

### 修复
- Web Surface 目录在会话创建、任务发现、派发、重试、分叉、恢复及事件流重连后自动更新，不切换当前会话；删除和归档按精确工作区身份移除本地行，保留同 ID 的远程会话。
- 全局任务通道补齐归档与恢复事件，仅转发会话身份，使其他已打开页面无需刷新即可同步。
- 并发 Surface 刷新合并为单个在途请求，丢弃被新查询取代的分页链；失败时保留原目录，并支持后续重试。

### 测试
- 新增 failing-first 回归，覆盖生命周期入口、刷新合并、查询范围切换、过期响应、精确身份隔离及归档/恢复 SSE 的私有字段过滤。
- 验证独立 Chromium 页面间的新建、归档、恢复和删除同步，全程不刷新页面、不改变导航，并保留 raw PTY 的 owner 状态检查。
- 扩展 DeepSeek Flash/Pro 真实 Chromium 轨迹，要求新派发任务在任何页面重载之前出现，并保留实时完成与持久化未读恢复验证。

## [0.10.147] - 2026-09-09

### 修复
- Web 侧栏不再用旧 Surface 目录快照覆盖较新的本地任务状态；状态分组、活动排序及停止、重试、归档操作随当前任务状态更新，无需刷新页面。
- 保留 V2 目录成员与精确工作区隔离规则；较新的 Surface 摘要仍优先于旧本地快照，远程历史状态保持独立。

### 测试
- 新增侧栏回归，覆盖项目与状态视图的实时任务迁移、等价时间戳、活动排序及较新目录快照。
- 扩展 DeepSeek Flash/Pro 真实 Chromium 轨迹，以独立且持续打开的页面验证任务完成、停止按钮消失、归档可用及前台会话不变，全程不重载页面或 Surface 目录，并保留原有离线未读恢复覆盖。

## [0.10.146] - 2026-09-08

### 修复
- SQLite 同步改用实际 transcript 源文件作为键，不再把有损反解的目录名当作工作区身份，防止含连字符、下划线的工作区会话从目录、搜索和归档操作中消失。
- Surface 历史关联当前选中的来源；源文件改变工作区身份时清理旧内容，选中来源被删除、失效或 rewind 后重新比较剩余副本。
- SQLite 派生缓存升级到 v8 并自动重建，不改写 JSONL 历史；保留未变化文件的读取跳过机制，并为源文件查询添加索引。

### 测试
- 新增 failing-first 回归，覆盖冷暖缓存身份、v6/v7 缓存重建、副本恢复、rewind、搜索残留清理、未变化文件读取次数和源文件索引。
- 在同时含连字符、下划线的工作区验证 Chromium 归档操作与 production raw PTY 会话列表，并通过既有 DeepSeek Flash/Pro 的 Headless、ACP、PTY、Web 八格真实 API 回归矩阵。

## [0.10.145] - 2026-09-08

### 修复
- 运行任务恢复改用绑定进程身份的 Session lease，不再仅依赖 PID 存活；覆盖本地、ACP 远程目录和 GUI/TUI Surface 读取，保持 owner 信息私有，并在恢复写入前验证精确工作区。
- 跨进程序列化 lease 记录的获取、接管和释放；身份采样或锁记录读取失败时保留所有权，不把未知状态误判为进程退出。
- Web 归档立即移除侧栏中对应的本地 Surface 行，并阻止旧目录响应复活已归档任务，不影响同 ID 的远程会话。

### 测试
- 新增 failing-first 回归，覆盖 PID 重用、并发抢锁、采样不可用、锁记录不可读、精确工作区隔离、单次恢复、远程状态隔离及归档目录竞争。
- 验证真实 Chromium 开发服务器归档操作和 production raw PTY 状态展示，并用既有八格真实 API 矩阵回归 DeepSeek Flash/Pro 的 Headless、ACP、PTY 与 Web 行为。

## [0.10.144] - 2026-09-06

### 修复
- 扩展后的 production surface 矩阵使串行 Linux CI 超过旧上限，因此将全量 coverage 的有界进程预算从 15 分钟调整为 20 分钟。
- 普通全量测试仍保持原有 10 分钟预算，单元、集成、性能与真实 API 的限制均不变。

### 测试
- 新增 test runner 契约，将 coverage 专用预算固定为 20 分钟，并在 failing-first 回归后通过全部 60 项 runner/qualification 测试。
- 保留上一 fixture 隔离 patch 的空 home 完整 coverage、四端确定性测试与 DeepSeek Flash/Pro `8/8` 资格证据。

## [0.10.143] - 2026-09-06

### 修复
- Durable Goal 回合链 production fixture 现在向父进程 Runtime 显式注入完整模型快照，并在结束后恢复原进程 store/catalog，不再依赖开发者个人 Blade 配置。
- Headless、ACP、raw PTY TUI 与 Chromium Web 子进程继续只使用隔离的临时 home 配置；真实 API 资格配置缺少模型时明确 fail closed。

### 测试
- 在空 `HOME` 下复现 release failure，并在独立提供 Playwright cache 后通过同一条四端 focused coverage 轨迹。
- 隔离修复后重新使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成 Headless/ACP/raw-PTY/Web `8/8` 真实 API 矩阵。

## [0.10.142] - 2026-09-06

### 新增
- 新增宿主权威、可持久化的 Goal 回合链，以有界 root、current 和直接 parent turn ID 覆盖 continuation、用户 follow-up、pending turn 与进程重启。
- 在 TUI 状态栏和 `/goal status`、双语 Web Goal 详情与 reload-safe DOM 属性、ACP metadata、Headless JSONL 中增加一等 lineage 投影，并补充双语 reference 与资格证据。

### 修复
- 固定先持久写入 `turn_started`、再按 Goal identity fence 提交 binding 的顺序；部分失败时释放 owner 或写 failed abort，避免 Provider 从幽灵或过期 lineage 开始执行。
- Goal edit 或同一 active turn 出现来源不明确的外部输入时使不可证明的 root 失效，拒绝 stale Goal progress，并确保内部 lineage 不进入 Provider prompt、权限语义、用户正文或 credential。

### 测试
- 新增 production Headless、真实 ACP stdio、raw PTY TUI 与 Chromium Web 确定性资格测试，连续三轮四端执行共 `12/12` passed。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成 `8/8` 真实 API 矩阵；每格验证三次模型真实工具决策和精确六次 Provider 请求，framework/model retry 均为 0，并覆盖 Web reload 恢复与 durable chain 精确一致。

## [0.10.141] - 2026-09-06

### 新增
- 新增 durable Goal execution-host failure guard：对 typed Bash timeout、admission、spawn、finalization、sandbox-start 与 terminal 故障分类，并跨 continuation 和进程重启持久化同类 streak。
- 在 TUI 状态栏与双语 Web Goal 控制区增加一等恢复状态，同时提供有界 ACP metadata 和 Headless JSONL 投影。

### 修复
- 同一类别连续第三个 execution-host failure logical turn 后自动阻断 active Goal，不再发起第四次 continuation；普通非零退出、测试失败、权限拒绝和用户取消不受影响。
- Bash 成功、类别变化、Goal edit、显式 resume 或 completion 时清除 streak，并确保 command、output、raw error、path 和 credential 不进入公开投影。

### 测试
- 新增 production Headless、真实 ACP stdio、raw PTY TUI 与 Chromium Web 确定性资格测试，并连续通过三轮四端执行。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成 `8/8` 真实 API 矩阵；每格验证三次模型真实 Bash tool call、精确六次 Provider 请求边界、Web reload 恢复和零第四个 logical turn。

## [0.10.140] - 2026-09-06

### 新增
- 新增 checkpoint 门控的 full-compaction 项目记忆巩固：从明确标记的偏好、约定、教训和已解决调试知识生成有界计划，执行精确去重、原子化项目级写入和受管 topic 发现。
- 在 TUI、Web UI、ACP metadata 与 Headless JSONL 中新增内容无关的记忆结果投影，并提供双语 Web/TUI 提示和完整 lifecycle 清理。

### 修复
- 阻止 credential、tool output、tool arguments、reasoning、metadata 和图片 URL 进入自动项目记忆；remote ACP workspace 继续禁止宿主写入。
- 保留流式阶段较晚到达的 TUI 状态消息，并阻止 hidden durable message 或非工具 part 通过 Web SSE replay 泄露。
- 修复测试 runner 忽略显式文件参数的问题，避免局部发布资格命令意外执行完整真实 API 矩阵。

### 测试
- 新增 production Headless、真实 ACP stdio、raw PTY TUI 与 Chromium Web 确定性资格测试，并连续通过三轮四端执行。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成 `8/8` 真实 API 矩阵，验证精确 final marker、新 Session 记忆发现、有界 metadata 和零 credential 泄漏。

## [0.10.139] - 2026-09-05

### 新增
- 新增进程级、按 failure domain 隔离的共享冷却：首次收到带有效正数 `Retry-After` 的权威 `429` 后，立即打开既有 Provider circuit。
- 新增限流专用 TUI 与 Web 恢复文案，同时保持 Runtime 统一投影、Web reload 恢复、ACP metadata 与 Headless JSONL 契约不变。

### 修复
- 阻止相同 Provider channel 的并发 Session 在服务端声明的冷却期内继续发起物理请求，同时保留唯一、有界的 HalfOpen probe 与既有 retry deadline。
- 缺失、零、负数、非有限、非 429、quota、billing、取消与 timeout 情况继续遵循原有分类和熔断策略。

### 测试
- 新增本地 HTTP 请求抑制覆盖，并连续三次验证 Headless、真实 ACP stdio、raw PTY TUI 与 Chromium Web production 表面，包含 Web reload、工具活动、终态 clear 与隐私检查。
- 在关闭 framework retry 的条件下，使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成八格真实 API 矩阵，验证单次注入 429、同域零提前流量、唯一恢复 probe、精确 Edit/Bash 产物、有界清理以及零 credential/private-body 泄漏。

## [0.10.138] - 2026-09-05

### 新增
- 新增由 Runtime 统一持有、带 generation/revision fence 的当前回合活动投影，覆盖启动、思考、响应、并行工具执行、压缩、继续、计数、数字进度与耗时。
- 重点建设 TUI 与 Web 活动表面，显示活动工具摘要、回合/工具计数，遵循专用状态优先级，并支持 Web reload 后从权威快照恢复。
- 新增 ACP `blade/turnActivity` metadata、封闭 schema 的 Headless JSONL `turn_activity`、双语 reference/evidence、production PTY/Chromium 确定性资格测试，以及 DeepSeek Flash/Pro 八格真实 API 矩阵。

### 修复
- assistant message 开始时不再清除 Web activity generation，避免后续工具 revision 被当作未锚定事件拒绝。
- 将无限 turn limit 规范化为 `null`，去除 ACP 重复 revision，并在终态、导航、取消、consumer close 与 Runtime dispose 路径一致清除瞬态状态。
- 工具参数、命令、输出、路径、prompt、URL、错误、进度文本和凭据均不会进入任何公开 activity 表面。

### 测试
- 新增 TypeBox、Runtime、Agent、lifecycle、TUI、Web、SSE、ACP、Headless、stale event、raw-PTY inventory、隐私、production 确定性及真实 API 覆盖。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 在 Headless、真实 ACP stdio、raw PTY TUI 和 production Chromium Web 完成 `8/8` 通过矩阵，并验证工具执行中的 Web reload 恢复。

## [0.10.137] - 2026-09-05

### 新增
- 新增由 Runtime 统一持有、带 generation/revision fence 的 Provider 恢复投影，覆盖准入等待、重试、共享熔断、输出停滞和 typed 跨模型 fallback。
- 重点建设两个主要用户表面：TUI 提供有界 loading/status 摘要与 Esc 提示，Web 在 composer 上方提供可访问恢复 banner 并复用既有 Stop 操作。
- 新增 Web SSE 重连安全 hydration、ACP `blade/providerRecovery` metadata、封闭 schema 的 Headless JSONL 事件，以及所有入口一致的净化 fallback source/target identity。
- 新增双语 reference 与 qualification evidence，记录 lifecycle、隐私、重放、清理、GUI、TUI、ACP 与 Headless 契约。

### 修复
- 阻止旧 generation、旧 revision 和未锚定的迟到 Web live 事件在终态清理或新 run 后复活恢复 UI。
- 在输出推进、完成、失败、取消、Session 替换、rewind、consumer 关闭和 Runtime dispose 时一致清理恢复状态，同时让多轮 Agent 执行共享同一个 generation。
- 保留绝对 retry deadline 与 waiting heartbeat，非法投影 fail closed，async generator 关闭会传播到底层 stream，旧 `model.fallback` 事件也不会覆盖权威 snapshot。

### 测试
- 新增 TypeBox、Runtime、Agent、TUI、Web、SSE、ACP、Headless、lifecycle、stale event 和隐私的确定性覆盖，并通过全仓 build、type-check、lint、test 与 performance 门禁。
- 使用 `deepseek-v4-flash` 和 `deepseek-v4-pro` 在 Headless、真实 ACP、raw PTY TUI 与 production Chromium Web 完成 `8/8` 真实 API 矩阵，包含恢复中 Web reload hydration 与终态 clear。
- 完成真实 Claude 到 GPT 的 pre-output fallback 验证，确认 typed identity 精确、credential channel 独立且不泄露 secret。

## [0.10.136] - 2026-09-05

### 修复
- 稳定 ACP remote Write 回读 deadline 回归测试：验证共享 deadline 的有界剩余预算，不再要求精确到毫秒的固定值。

## [0.10.135] - 2026-09-05

### 修复
- 将 durable follow-up queue HTTP/SSE 集成测试的临时 workspace 绑定为模型解析使用的进程 workspace，消除对开发者 home 配置的隐式依赖。
- 清理已完成的 SSE read timer，并增加有界且区分阶段的诊断，使 CI 能精确报告缺失事件且不残留过期 timer。

## [0.10.134] - 2026-09-05

### 新增
- 新增 authoritative durable follow-up queue：提供有界 preview、不可变 internal barrier、精确 version token、重启安全顺序，以及带乐观并发控制的删除与移动操作。
- 重点建设两个主要用户表面：TUI 在活动回合中提供带完整键盘导航的 `/queue` 面板，Web 提供可访问按钮、drag reorder、reload 恢复和 stale-state 提示。
- 新增兼容标准的只读 ACP 队列生命周期投影，只包含 version 与聚合计数，不声明自定义 mutation capability。

### 修复
- 阻止 pending follow-up 在 `steering_applied` 前显示为已提交 transcript 消息，并避免删除待处理项后留下 ghost user message。
- 使用进程内锁和文件锁串行化跨实例 inbox 写入，并通过原子替换、owner epoch fence、exact Session identity 与 fail-closed storage error 保证一致性。
- 保留普通取消语义：停止活动回合不会把 `session/cancel` 重新解释为删除队列。

### 测试
- 新增 Runtime、持久化、HTTP/SSE、Web、TUI 与 ACP 的确定性覆盖，验证迁移、竞态、stale version、不可变 barrier、重启恢复和 metadata 隐私。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 验证 production Web、raw-PTY TUI 和真实 SDK ACP；framework retry 为 `0`、model `maxRetries=0`，每条轨迹包含 1 个 setup request 与 1 个 queue-consumption request，并验证精确保留顺序、删除 marker 不出现、有界清理和零 credential 泄漏。

## [0.10.133] - 2026-09-04

### 新增
- 为已知后台任务新增 durable TUI attention：任务在 TUI 缺席期间进入 completed、failed 或 interrupted 后，`/resume` 会显示 `[NEW]`，状态栏会显示未读数量，且不与 Web UI 共享确认状态。
- 新增私有、有界、跨进程 ledger，使用 canonical terminal signature、SHA-256 locator 摘要、原子持久化、有序失败重放、exact Session 确认和首次终态静默基线。

### 修复
- 在取消选择、激活失败或过期、跨 workspace 同 ID Session、fork、同步失败、StrictMode lifecycle 重放和 shutdown 竞态中保留 unread；只有已证明成功打开的 exact Session 才会清除提醒。
- 将 production dist 构建统一前置到依赖它的 Vitest 进程之前，在保持非 coverage 与 coverage 项目顺序的同时，避免并行 worker 读取正在重建的 `dist`。
- 对 raw PTY 资格验证中的 Provider completion、HTTP 请求、runner 与子进程清理、递归错误脱敏和 runner 凭据隔离建立有界、fail-closed 的生命周期。

### 测试
- 新增 production raw PTY 确定性覆盖，验证静默基线、错过终态、`[NEW]`、精确恢复、transcript 内容、确认持久化、callback 失败、callback 卡住及 outer runner timeout。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 各完成一次真实上游请求；framework retry 为 `0`、model `maxRetries=0`，并验证精确持久化终态内容、有界诊断和零 credential 泄漏。

## [0.10.132] - 2026-09-04

### 修复
- 稳定 ACP remote workspace-reference 容量协调：在协商 SQLite WAL 前先安装 busy waiting，并移除容量事务外每个连接的 WAL-to-DELETE 切换。
- 从数据库初始化阶段开始使用 coordinator 的 30 秒等待预算，并在初始化 PRAGMA 失败时关闭连接；同时保留 `BEGIN IMMEDIATE`、identity 校验、1,024 条 binding 上限与固定脱敏错误。

### 测试
- 新增初始化顺序契约、真实 Node / `better-sqlite3` 排他锁测试，以及真实 Bun 跨进程容量与 killed-owner 的重复回归覆盖。

## [0.10.131] - 2026-09-04

### 修复
- 为 Web 中已知后台任务补齐 durable unread 恢复：任务若在页面 reload 或断线期间进入终态，会按 exact 项目与 Session identity 的版本化已读终态 ledger 恢复提醒。
- 仅在 winning Session catalog 完整加载后 reconcile attention，并通过 monotonic upsert/remove overlay 保留分页期间更新的 task 与 Session lifecycle 状态。
- 首次发现的历史终态保持静默、已读结果不会再次复活、不同项目的同 ID 任务互不影响，级联归档也会清理尚未加载子任务的 attention 状态。

### 测试
- 新增 ledger、live event、分页、generation、lifecycle overlay、archive 与 no-revival 的因果覆盖，并加入完整 unread/reload/click 用户旅程的 production Chromium qualification。
- 使用真实上游请求验证 `deepseek-v4-flash` 与 `deepseek-v4-pro`，framework 与 model retry 均为 0，并验证 exact compound Session 导航、sibling 隔离及 browser/server/credential-leak fault 全部为空。

## [0.10.130] - 2026-09-04

### 修复
- 收紧 ACP remote 工具执行边界，在 hook、调度、锁、工具调用或远端文件系统 I/O 前校验 `file_path`、`notebook_path`、写工具 `path` 及全部显式声明的 affected path。
- 保留内置 `ApplyPatch` 由事务层处理相对路径的专用 preflight，同时阻止同名动态工具绕过通用校验。
- 将 affected-path 推导异常脱敏为固定 `acp_remote_path_invalid` 结果，并保持 local 与 ACP-local 执行语义不变。

### 测试
- 新增通用路径、多路径、hook 改写、双固定字段、内置身份、推导异常脱敏、local 兼容与 readonly 业务路径的因果覆盖。
- 使用 `deepseek-v4-flash` 与 `deepseek-v4-pro` 在 framework retry `0` 下重新验证 paired ACP remote filesystem、raw PTY TUI 与 production Chromium Web 路径。

## [0.10.129] - 2026-09-02

### 新增
- 新增统一且有界的 V2 Session catalog 与 history surface，覆盖 local 和 ACP remote Session，并采用 opaque public workspace reference、严格 TypeBox contract、snapshot-bound pagination 及白名单化的 user/assistant 消息。
- 重点建设 Web GUI 与终端 TUI 的 remote history 体验，支持 remote/连接状态标记、canonical display path、增量分页、已加载页面搜索、复制、fork、刷新恢复及明确的 history-only 提示。
- 新增双语 reference 与 qualification evidence 页面，记录用户流程、隐私和 capability 边界、实现责任、完整仓库门禁、coverage，以及零重试 production GUI/TUI 验证。

### 修复
- 每次操作均重新校验 exact、generation-current 的 ACP ownership；owner 离线后仍可读取已持久化历史，同时阻止 public reference 或 display path 成为执行授权。
- 将 remote history-only view 与 local Session state 隔离，并在 presentation 和 dispatch 两层阻止 prompt、file、terminal、Browser、review、rewind、task、subagent 与 per-Session SSE 活动。
- 从 catalog title、SQLite/JSONL history、error、URL、log 与 browser surface 中清除 remote wire path、protected host-state root、descriptor identity 和 legacy private canary，同时保留 canonical remote display path。
- 在 filesystem、Git、project resource 或 PTY 工作开始前，拒绝通过 legacy local Session、suggestions 与 terminal route 传入 protected ACP state root。
- 对 suggestions tree/content path 同时执行 lexical 与 canonical containment，阻止父目录 traversal 及 workspace 内 symlink 暴露本地 workspace 外的文件或目录名。

### 测试
- 使用 Playwright Chromium 验证 production Web surface，并以真实 Ink input 验证终端 surface；`deepseek-v4-flash` 与 `deepseek-v4-pro` 均在 framework retry `0`、model `maxRetries=0` 下通过。
- 新增 schema、protected reference、owner generation、projection、cursor、service、route、Web、TUI、lifecycle、privacy 与 local compatibility 的确定性覆盖，并通过完整仓库及独立 CLI/Web coverage 门禁。

## [0.10.128] - 2026-09-02

### 新增
- 新增 ACP Win32 remote path identity hardening 的双语 reference 与 evidence 页面，覆盖冻结 path profile、durable remote workspace identity、exact 与 collision path 职责划分、typed remote path / patch validation error，以及 Tasks 1-8 的有界 release-evidence 结构。

### 修复
- 将 ACP remote path style 冻结到 Session workspace，保留用于 RPC 的 case-sensitive wire path，并把 exact ledger authority 与保守 collision fencing 分离，避免 Windows 大小写别名等路径拼写静默复用写入授权。
- 将 ACP remote Session 统一路由到受保护的 host-private state root 与显式 execution/resource roots，在保留 durable remote workspace descriptor 的同时，阻止 host-only workspace config、hooks、LSP、Git、task isolation 与 local terminal fallback 回流到 remote path。
- 兼容由当前用户拥有且 group/world 不可写的既有 Blade storage root，同时继续要求 ACP remote namespace 与 digest scope 使用私有 `0700` 权限。
- 让 remote single-file tools 与 update-only `ApplyPatch` 在进入 host-private patch state、locks、leases 或 remote write 之前，就对 unsafe Windows spelling、workspace escape、restricted target 和 duplicate target 统一 fail closed。
- 统一 remote Read / Write / Edit 结果中的 canonical path 与跨平台 Windows basename，并从模型可见错误文本中移除 not-found 和匹配失败路径。
- 从 ToolExecutor invalid-path preflight 与 unknown-session Write / Edit metadata 中移除被拒绝的 raw path，并在 helper 类型边界阻止其重新引入。
- 通过 TUI / ACP / Headless / Web 共用的展示格式化器，仅呈现 allowlist 内的固定 ACP filesystem 错误，未知 Client 错误继续保持通用提示。

### 测试
- 记录 Task 1-8 的 causal RED 命令、commit responsibility 映射、focused deterministic 与 GUI/TUI 结果、独立审查、全量测试与 coverage 门禁，以及零重试双模型 real-API qualification。

## [0.10.127] - 2026-08-31

### 新增
- 新增 ACP filesystem request lifecycle 的双语 reference 与 evidence 页面，记录公开 typed ACP request API、生命周期预算、request slot 计数、generation-safe quarantine，以及 ACP receipt UI projection 的明确 non-goal。

### 修复
- 将 ACP remote 文本请求统一收紧到公开 `AgentSideConnection.request(...)` 调用、cooperative cancellation、默认 30 秒 request budget、保留 recovery lane，以及同 connection normalized path 上 generation-safe 的 `pending-write` / `needs-read` fence。
- 让 remote Write / Edit 在 preflight 前先获取 mutation lease，并保持 remote ApplyPatch 的顺序为先 precheck、后 host-private state，再进入 workspace lock、sorted opaque locks、atomic leases、有界 forward 执行与逆序 verified compensation。
- 保持 local 与 ACP-local 文件语义不变，继续将 remote ApplyPatch 限定为 update-only 和既有 100 operation cap，并维持稳定、脱敏的 uncertainty metadata，而不是引入 ACP 专属 receipt UI。

### 测试
- 记录 Tasks 1-5 的 causal RED、focused unit/integration/Web fresh evidence，以及完整 request lifecycle patch 的独立规格审查和质量审查结论。
- 记录 `deepseek-v4-flash` 与 `deepseek-v4-pro` 的零重试真实 ACP qualification，并只保留 canonical field-only SHA-256 evidence。

## [0.10.126] - 2026-08-30

### 新增
- 新增 Session 冻结的 ACP 远端文本文件系统所有权、session-scoped SHA-256 remote-read ledger，以及不依赖同名宿主路径的 opaque remote coordination 与 lock identity。

### 修复
- 让 unsupported binary、stat、mkdir、delete、rename 等非文本 ACP 文件系统操作统一 fail closed，不再回退到 Blade 宿主机。
- remote Write / Edit 现在同时要求 `readTextFile` 与 `writeTextFile`，并要求 prior matching Read digest；new-file Write 仅接受明确的 ACP not-found preflight 结果。
- 将 remote mutation 收紧为一次写入加有界 read-back 校验，覆盖 acknowledged write、ack loss 与无法证明最终状态时的 truthful uncertainty 归类。
- 将 remote ApplyPatch 限定为带补偿的 `Update File`，支持逆序 verified compensation 与 abort-safe rollback；不声称 ACP 原生支持 multi-file transaction 或 remote parent mkdir。
- 收紧 remote Read error redaction，保留 duplicate initialize 下的 ownership freeze，并保持 ACP-local 在未冻结 remote owner 时与本地 backend 语义一致。

### 测试
- 新增 paired ACP、host canary、session-scoped ledger、rollback、cancellation、opaque coordination 与 UI projection 边界的确定性覆盖。
- 通过 `deepseek-v4-flash` 与 `deepseek-v4-pro` 完成 production BladeAgent paired ACP 资格验证，framework retry 为 `0`。

## [0.10.125] - 2026-08-30

### 新增
- 新增有界 Web Session projection 驻留：支持配置条目上限与空闲时间，按空闲 LRU/TTL 回收，并返回类型化容量错误。

### 修复
- 为 hydration、active run、review、shell、Browser 操作、破坏性 Session 变更、controller replacement 与 shutdown 建立 projection generation 和长生命周期 owner fencing。
- 保持 pending-resume projection 所有权在并发 SSE wake 下 single-flight，并在恢复、取消、启动失败和预算耗尽时释放 episode lease。
- 保留 Session fork 的 exact-workspace `404` 语义，并将成功 fork 的 projection 提交到生成出的真实 child identity。

### 测试
- 新增 residency、capacity、hydration、Browser operation、close/rollback、replacement、shutdown 与 pending-resume ownership 的确定性回归。

## [0.10.124] - 2026-08-30

### 修复
- 按不可变 parent owner 路由后台 subagent 的终态 callback，使旧 `SessionRuntime` 捕获的 callback 在同进程 Runtime 替换后能够送达当前已 attach 的 Runtime。
- 按 owner 串行 dispatcher attach、初始 reconcile、completion delivery 与 detach；Runtime dispose 改为 single-flight，并在释放 Session lease 前 fail closed 地等待已有 completion 工作收敛。

### 测试
- 新增 Task/Team 顺序、provenance 拒绝、重入、handoff、修复、waiter 与 dispose 的确定性回归。
- 新增关闭重试的 DeepSeek Flash/Pro 资格验证，证明 running child 可跨 Runtime A→B 替换存活，并恰好一次唤醒 B 的 live durable mailbox。

## [0.10.123] - 2026-08-30

### 修复
- 为 TUI 自动恢复 durable pending input 增加有界 outer retry，复用最多 4 次、总预算 120 秒的共享策略，并在已有输出、工具活动、取消、证据畸形或 inbox 已清空时 fail closed。
- 为 pending-resume retry 增加 generation fencing、绝对 deadline、idle-aware 调度与可取消所有权；Session 切换、前台任务、cleanup 和 unmount 均不会丢失或复活旧恢复，同时普通命令和 Goal 不进入重试。

### 测试
- 新增 replay-boundary 与 coordinator 的确定性回归、关闭内部重试的 DeepSeek Flash/Pro 一次性 `503` 真实资格验证，以及通过 production raw PTY 证明两次有序 attempt 和唯一一次已确认 `Write`。

## [0.10.122] - 2026-08-30

### 修复
- 为 TUI Runtime 与 Agent 初始化增加 generation fencing、exact-target single-flight 和 cleanup ownership，覆盖 unmount、graceful shutdown、Session/workspace 切换与并发 turn。
- 在创建下一轮 Agent 前完整销毁上一轮 Agent，传播真实 cleanup 错误，并让生命周期取消在命令输出中保持静默。

### 测试
- 新增确定性的 Promise-gated 所有权回归、DeepSeek Flash/Pro 双轮真实模型资格验证，以及关闭 framework retry 的 production raw-PTY follow-up 控制。

## [0.10.121] - 2026-08-29

### 修复
- 以精确 generation 为 delete、archive、controller replacement 与 shutdown 期间的异步 Web Session hydration 建立 fencing，防止过期任务重新写入 live projection。
- 将 durable permission recovery 统一到 active controller 的 single-flight hydration owner；没有 active controller 时仍保留已提交的响应，但不创建无 owner 的 live state。

### 测试
- 新增确定性的 Promise-gated 回归，覆盖过期 hydration commit、生命周期错误、generation ABA 安全、permission recovery ownership、archive 失败保留以及普通 same-key single-flight 行为。

## [0.10.120] - 2026-08-29

### 修复
- 从 Web server 的 live Session projection 中移除完整 transcript 数组，使 SSE 与 Browser 访问不再在没有 Runtime 的情况下常驻历史规模内存。
- 将 active 与 cold Session 的消息计数统一为 durable user/assistant metadata，同时保留按请求读取 history 和 Runtime 自主管理 model context 的边界。

### 测试
- 新增 AST 与 route 回归，覆盖 history-free hydration、durable message 读取、Browser 访问、cold resume context，以及 authoritative rewind/shell metadata。

## [0.10.119] - 2026-08-29

### 修复
- 将 global 与 Session SSE 连接纳入 controller 显式所有权，并在 Runtime teardown 前终止连接、等待 callback 工作收敛。
- 将 Node 客户端断开传播为 Fetch request cancellation，并调整 graceful shutdown 顺序，使存量 SSE 不再阻塞 server stop。
- 保留确定性的 cleanup 错误与 server ownership，使失败的 shutdown 可诊断、可重试。

### 测试
- 新增 controller、handoff 前 abort、per-stream 隔离、真实 Node 断线、graceful stop 与 cleanup retry 的确定性回归。

## [0.10.118] - 2026-08-29

### 修复
- 清理已完成创建但在 residency 接管前失败的 Web Session Runtime，并在清理本身失败时保留原始初始化错误。

### 测试
- 新增确定性的 SSE/shutdown 竞态覆盖，验证延迟 Runtime 创建、精确 pre-commit 清理、空 residency 状态与清理错误优先级。

## [0.10.117] - 2026-08-29

### 修复
- 让 production ACP pending-resume completion 等待精确 terminal metadata 投递，并确保 egress 失败不会重试已经完成的 durable turn。
- 在 busy operation、取消、销毁和有界 ACP writer 失败期间保留 retry backoff 与 wake 所有权。

### 测试
- 新增 incomplete metadata prefix、malformed update、absolute polling deadline、deferred/rejected writer、teardown join、取消与 busy-operation wake 时序的确定性覆盖。
- 使用真实 DeepSeek 请求和零 framework retry 重新验证一次性失败后的 production ACP recovery 路径。

## [0.10.116] - 2026-08-29

### 修复
- 新增 opt-in、nonce-bound 的 OSC readiness handshake，仅在 active TUI composer input handler 注册完成后输出。
- 让所有发送 prompt 的 raw PTY runner 等待各自 child 的精确 readiness marker，并删除 token-budget runner 的五秒 bracketed-mode fallback。

### 测试
- 新增 nonce 校验、注册时序、runner 清单、wait-before-paste 与跨 chunk marker 的确定性覆盖。
- 使用真实 Provider、零 framework retry 验证 DeepSeek Flash/Pro 的 token-budget 与 large-prompt raw PTY cell。

## [0.10.115] - 2026-08-29

### 修复
- 进程重启后，当全部成功结果都来自 host 校验且副作用已知安全的 foreground Task adoption 时，允许 parent turn 自动继续。
- 使用 v3 recovery proof 跨重复重启持久化安全语义，同时让普通成功工具、interrupted tool、legacy receipt 以及 malformed 或 unsafe adoption 继续进入显式人工处置。

### 测试
- 新增严格 adoption 身份、mixed result、interrupted tool、malformed proof、二次重启与 ACP v2/v3 兼容覆盖。
- 使用真实 Provider 且关闭 framework retry，重新验证 DeepSeek Flash/Pro 在 Headless、ACP、raw PTY 与 production Chromium Web 上的 adoption。

## [0.10.114] - 2026-08-29

### 测试
- 稳定 durable recovery 的 final-marker 资格校验，在判断最终响应前区分任务生命周期尚未完成与结构不匹配。
- 隔离 durable raw PTY 与通用 foreground PTY 的 marker 协议，并补充 ACP、PTY、有界输出和轨迹 harness 的确定性回归测试。

## [0.10.113] - 2026-08-29

### 文档
- 记录共享 pending-resume 决策策略、Web 与 ACP 各自的生命周期边界、零副作用重放门禁，以及 CLI/TUI 不执行 whole-turn 自动重试的边界。

### 测试
- 新增 durable pending interaction 的真实 DeepSeek 资格验证，覆盖 production Chromium、基于 SDK stdio 的 production ACP child，以及 raw PTY 中的 production CLI。
- 加固一次性 `503` 注入、真实上游流生命周期、持久化答案与最终输出精确性、先失败且未确认再成功确认的 turn 顺序、唯一 `Write`、reload 与 shutdown、Web/PTY prompt-isolated marker，以及有界脱敏诊断。

## [0.10.112] - 2026-08-28

### 修复
- 将无 Goal Session 的 frontier stall 清理改为原子 no-op，避免普通写入回合和恢复中的待处理交互在工具成功后异常失败。

### 测试
- 新增 GoalStore 与 Agent loop 的无 Goal 写入回归测试，并通过 production Chromium、真实 DeepSeek 请求和一次瞬态故障注入验证修复后的完整路径。

## [0.10.111] - 2026-08-28

### 修复
- 当较早发起的权威消息重同步晚于 Session SSE 初始化完成时，保留已重放的 permission、question 和 elicitation 待处理卡片，并在精确交互解决后继续移除卡片。

### 测试
- 新增 idle status / resync 竞态与陈旧交互移除的确定性覆盖，并加入可复用的一次性 Provider 故障注入和有界 production Web 恢复证据校验。
- 完整确定性套件 4,417 个测试通过，Web 套件 509 个测试通过。

## [0.10.110] - 2026-08-28

### 新功能
- 将有界 Web pending-resume 恢复状态投影到当前 Session store 与状态栏，显示尝试次数和重试延迟且不暴露 Provider 详情。

### 修复
- 在 Session 切换、终态事件、rewind、取消和精确 Session 用户新回合时清理瞬态恢复状态，同时在恢复中的 assistant 输出期间保留状态。

### 测试
- 新增严格 payload 校验、workspace identity、生命周期重置、状态优先级和隐私覆盖；Web 套件 65 个文件、507 个测试通过。

## [0.10.109] - 2026-08-28

### 修复
- Web pending-resume 的失败终态现在可跨 SSE 重连保留，新的唤醒不会重置零副作用门禁或四次/120 秒恢复预算。
- 重试在启动前失败或共享 deadline 在 Agent 创建前耗尽时会 fail closed，并保留规范错误与持久化任务状态。
- 在启动 run 前再次校验 retry attempt 所有权，避免 abort、删除、controller replacement 或 shutdown 后旧回调复活已取消工作。

### 测试
- 新增 Runtime lease 交接、终态持久化失败、SSE 重连、启动前 deadline 和清理竞态的直接回归覆盖。
- 验证 443 个确定性测试文件、4,406 个通过测试；82 个需要凭证的真实 API 用例按条件跳过。

## [0.10.108] - 2026-08-28

### 修复
- 隔离 Web pending-resume route 夹具与共享 module/Agent mock，使 Headless Core coverage 能稳定观察真实的 single-flight 生命周期。

### 测试
- Headless Core 现在包含 Web pending-resume 场景并完整通过 9 个文件、391 个测试的 recovery gate。

## [0.10.107] - 2026-08-28

### 修复
- Web pending-resume recovery 现在具备 single-flight、等待 cleanup、shutdown/新输入可取消，并使用共享的有界重试策略。
- 通过 React `act` 刷新快捷键状态切换，稳定 coverage 下 CLI transcript pager 的集成行为。

### 测试
- 新增 Web pending-resume ownership、cleanup、取消、deadline 和并发唤醒覆盖。
- 验证完整 coverage 套件：443 个文件通过，4402 个测试通过。

## [0.10.106] - 2026-08-28

### 修复
- 将 Provider recovery budget、request deadline 和 stream idle 超时统一为规范的可重试 task failure，同时不泄露 Provider 详情。
- 加固 task failure 投影，拒绝 malformed canonical payload，并安全处理循环或过深的错误链。

### 测试
- 新增嵌套错误、有界深度、规范 payload、循环链和敏感详情回归覆盖。

## [0.10.105] - 2026-08-28

### 修复
- 没有可审计 liveness 信号时，不再把普通的未变化 Goal 任务误判为停滞。
- 首屏不再预加载尚未使用的 session-event 模块，在不改变事件顺序的前提下使 Web 启动包保持在预算内。
- 在 ACP 与后续 Web recovery 编排之间共享有界 pending-resume recovery policy。

### 测试
- 重新运行 CLI 和 Web 全量测试、生产构建、真实 DeepSeek Goal recovery，以及生产 Web GUI reload 资格轨迹。
- 新增 pending-resume policy 的 replay boundary、尝试次数和恢复预算确定性测试。

## [0.10.104] - 2026-08-28

### 修复
- 按仓库格式规范整理 Goal frontier runtime 和资格测试改动，修复 CI Quality Gate 的格式检查失败。

### 测试
- 格式化后重新运行 format、type-check、生产构建以及 Runtime/Web 重点回归门禁。

## [0.10.103] - 2026-08-28

### 新增
- 新增 durable Goal frontier 停滞分类器，识别依赖等待、任务前沿无变化和重复延期。
- 新增有界策略切换提示，并将停滞诊断投影到 Headless JSONL、CLI TUI、Web SSE/DOM 和 ACP metadata。

### 修复
- Goal frontier 在同一回合刷新时现在会保留诊断但不会错误增加跨 continuation 计数；workspace mutation 会清除过期停滞状态。

### 测试
- 新增持久化、continuation、schema 和跨端投影的确定性覆盖。
- 使用真实 DeepSeek Goal 轨迹和生产 Web GUI reload 轨迹完成资格验证。

## [0.10.102] - 2026-08-28

### 新增
- 新增基于现有 TaskList 的 Goal 作用域 durable execution frontier，提供稳定的 Goal 隔离，并按 Team > Goal > Session 解析任务作用域。
- 新增有界 frontier 刷新与 continuation 注入；每次 Provider 调用前都会读取最新任务计数、依赖阻塞、下一可执行任务和摘要哈希。
- 新增 GoalSnapshot v2 持久化，兼容读取 v1，并支持 frontier 原子更新和未完成任务完成保护。
- 新增 frontier 到 Headless JSONL、Web SSE/store、ACP metadata + plan 和 CLI TUI 任务面板的投影。
- 新增终端 transcript pager 全文搜索和剪贴板复制。

### 修复
- 补齐 Web 预览显示模式翻译，并增加可在 reload 后验证 Goal frontier 的有界 GUI DOM 属性。
- Goal frontier 读取失败时现在会以可恢复的类型化诊断暂停 Goal，不再把未知任务状态当成空列表继续执行。

### 测试
- 新增 frontier、GoalStore 迁移、作用域优先级、continuation 和跨端投影的确定性测试。
- 使用真实 DeepSeek 完成 Runtime、Web REST、ACP 和生产 Web GUI reload 资格轨迹，浏览器断言全部通过。
- Bun 1.3.11 下 build、type-check、lint 和全量测试门禁通过：4,322 项通过，保留 82 项条件跳过。

## [0.10.101] - 2026-08-27

### 新增
- 新增入口无关的 durable turn recovery assessment，并统一投影到 CLI TUI、
  Headless/Print、Web 和 ACP，包括已恢复完成状态
- 新增按 turn 持久化的 recovery acknowledgement；即使 active Goal 没有 inbox
  输入，人工确认也能跨进程重启保留

### 修复
- 工具已成功或执行状态不明时，自动续跑会等待显式输入确认外部状态已检查；被门禁的
  task Session 保持可恢复状态，不再被错误记录为 completed
- 旧 v1 abort receipt 会从合成的 process-restart tool result 回填不确定副作用证据，
  避免升级后重放状态不明的工具调用
- 无输入的 Headless 和 Print 恢复会明确失败，不再返回空成功；Headless 使用退出码 2
  表示需要人工处理
- ACP JSON-RPC 错误数据现在会随规范化错误保留 runtime model ID，同时不暴露原始
  Provider 详情

### 测试
- 新增连续重启、v1 迁移、持久确认、task 状态、rewind、Headless/Print、TUI、Web
  和 ACP 回归覆盖
- 使用真实 DeepSeek API 完成 Headless、ACP、raw PTY TUI、production Web GUI/reload
  四入口资格测试，并验证文件副作用只发生一次

## [0.10.100] - 2026-08-27

### 修复
- Goal 完成验证现在把宿主已接受的 `verifying`/`pending` candidate 视为
  `UpdateGoal complete` 已提交的权威证据，避免 verifier 在给出 verdict 前反向要求
  Goal 已经 `complete` 或已有 PASS 的循环依赖
- candidate 事实仅证明控制面动作；verifier 仍必须独立验证每项交付物、测试、命令和
  用户可观察结果

### 测试
- 收紧真实 DeepSeek premature-stop 恢复轨迹，要求首次 completion candidate 直接
  PASS，且不得出现中间 FAIL/PARTIAL verdict；同时覆盖直接 Runtime、verifier 反馈、
  production Web 和 ACP 路径

## [0.10.99] - 2026-08-27

### 新增
- 原生 Browser Tool 成为 Web/UI 可视任务的默认执行与验证路径，任务完成前需要执行
  真实 GUI 验证
- 新增多模态 `click_at` 兜底，使用最新截图授权、稳定帧检测、viewport/origin 绑定、
  像素过期拒绝和 frame 区域 fail-closed 保护
- Web 用户 Test 浏览器新增元素拾取：可直接在截图上选择带 box 的 ARIA 区域，并将
  有界且标记为不可信的元素上下文追加到当前 Session 输入框

### 修复
- 主视图导航现在会关闭设置页，点击新建任务、任务看板、项目或 Session 时不再被设置
  页面继续遮挡

### 测试
- 新增 Browser 提示、schema、多模态 Provider 上下文、截图授权、Web 投影、Composer
  草稿和导航回归测试
- 使用真实 Chromium、原生 Web GUI 交互，以及 Headless、TUI、Web、ACP 的八单元
  DeepSeek 零重试矩阵完成 Browser 流程资格验证

## [0.10.98] - 2026-08-27

### 修复
- ACP 在 durable pending input 自动恢复遇到规范化瞬态失败时，使用单飞、有界退避、
  稳定抖动和硬恢复时限自动重试
- 自动恢复一旦产生部分输出或执行工具便默认停止重试；取消、egress 失败或 Session
  销毁也会使排队中的尝试失效

### 测试
- 新增完整的 ACP 重试生命周期覆盖，以及注入一次 HTTP 503 的真实 DeepSeek 轨迹，
  验证恢复输入投影和文件副作用均只发生一次

## [0.10.97] - 2026-08-27

### 修复
- 恢复任务 Session 时，如果其托管 worktree 已缺失、元数据不匹配或不再注册，现在返回
  规范化的 `workspace_unavailable` 失败，而不是退化为笼统的运行时错误
- Server 与 Web 表面将不可用的任务 workspace 映射为 HTTP 409，并在任务状态中保留
  类型化失败信息，使用户能够获得可执行的恢复提示

### 测试
- 新增缺失、元数据不匹配及未注册 task worktree 的单元、集成和 Web 组件覆盖

## [0.10.96] - 2026-08-27

### 修复
- 工具调用重试改为默认关闭：只有显式声明可安全重放的本地查询工具才会重试瞬态资源
  错误，避免 Bash、文件写入、MCP 调用、stdin 写入及其他副作用在完成状态不确定时被
  重复执行
- 查询工具适配层现在会保留结构化的可重试错误链，不再把瞬态失败误报为“文件不存在”
  或空状态；Prompt Artifact 初始化失败后也可重新恢复
- 重试退避现在响应取消信号，取消后不会再启动下一次工具调用
- Web 在 SSE 重同步已经替换 optimistic 消息时仍会展示 HTTP 明确拒绝，确保容量错误反馈
  不会被误判为请求已成功

### 测试
- 新增内置工具重试安全能力的全量清单门禁，以及真实文件系统集成测试，验证状态不明的
  副作用只执行一次
- 强化 raw PTY 发布资格验证：强制子进程采用交互式渲染，匹配当前 composer 标记，并
  对 bracketed-paste 输入进行分块写入

## [0.10.95] - 2026-08-26

### 新增
- Agent 调用原生 Browser Tool 时，Web 会自动打开 Browser 面板，并将 Test 模式切换到
  只读的 Agent 视图
- Agent Browser 交互会投影有界的目标几何信息，Web 面板可在最新截图上显示鼠标移动与
  点击反馈

### 安全
- Agent 浏览器观察只使用校验 origin 的只读截图接口，不签发新快照、不暴露页面内容，
  也不把 Agent BrowserContext 的控制权交给 Web UI

### 测试
- 扩展真实 DeepSeek production Web 轨迹，强制验证面板自动打开、Agent 截图、鼠标反馈
  以及用户控制禁用状态

## [0.10.94] - 2026-08-26

### 修复
- 停止 Web 任务时延后权威历史同步，直到服务端进入稳定 idle 状态，避免当前任务
  信息流被临时空快照清空

## [0.10.93] - 2026-08-26

### 修复
- 格式化 Browser Panel production qualification fixture，使仓库质量门禁能够校验
  发布源码

## [0.10.92] - 2026-08-26

### 新增
- 新增统一 Web Browser 面板，提供 iframe 预览、独立 Chromium 测试和显式系统
  浏览器三种模式
- 新增 Session 级 Web Browser 导航、交互、快照、诊断、截图与重置 API

### 变更
- Web 测试浏览器使用独立、临时的 `BrowserContext`，用户操作不会接管 Agent
  Browser Tool 的页面、Cookie 或快照 ref
- Lucide 图标改为跟随 Vite 动态 chunk 图分配，不再强制进入 Web 首屏 bundle

### 安全
- Web Test 复用 Browser Runtime 的 URL、origin、弹窗、下载、资源与脱敏边界，并在
  reset、删除 Session 和 server shutdown 时释放上下文

### 测试
- 新增路由、生命周期、截图、交互、过期快照、响应式 UI、真实 Chromium 与
  production Web 轨迹覆盖

## [0.10.91] - 2026-08-26

### 修复
- CI 覆盖率发布升级至使用 Node.js 24 Runtime 的 `codecov/codecov-action@v7`
  与 `actions/upload-artifact@v7`，并新增完整 workflow 库存测试，防止旧版
  action 回归

## [0.10.90] - 2026-08-26

### 修复
- CI 依赖缓存与 Playwright 浏览器缓存统一升级至使用 Node.js 24 Runtime 的
  `actions/cache@v6`，并新增完整 workflow 库存测试，防止旧版 cache action 回归

## [0.10.89] - 2026-08-25

### 修复
- CI coverage 现在会配置固定版本 Chromium 的系统依赖与 SUID sandbox helper，
  在测试前验证沙箱启动，并通过 Browser Runtime 环境白名单传递 helper 路径

## [0.10.88] - 2026-08-25

### 修复
- CI coverage 在执行浏览器集成测试前会显式安装并缓存固定版本的 Playwright
  Chromium Runtime

## [0.10.87] - 2026-08-25

### 新增
- 新增六个延迟加载的原生 Browser 工具，覆盖导航、无障碍快照、基于 ref 的交互、
  等待、诊断、截图和页面管理
- 新增显式的 `blade browser install` 与 `blade browser status` 命令，用于管理固定
  Playwright 1.62.1 版本对应的 Chromium Runtime

### 变更
- 浏览器自动化改为全进程惰性共享一个 Chromium，每个 Session 独占一个隔离且临时的
  BrowserContext
- CLI、Headless、Web 与 ACP 统一消费同一套 Browser Tool 结果和有界 metadata 契约；
  现有 iframe Browser Preview 保持独立
- Session 截图使用私有内容寻址存储，并通过与所属 Session 相同的规范化 workspace
  identity 清理

### 安全
- 显式启用 Chromium sandbox；浏览器进程只接收白名单环境变量，不继承 Provider 凭据
- 导航与交互权限按规范化 HTTP(S) origin 隔离，并执行过期 snapshot/ref 校验和操作前后
  origin 复核
- 阻断跨 origin 导航、popup 与 frame 交互；opaque sandbox frame、凭据控件、下载、
  任意 selector、脚本执行、上传、持久化 profile 与 storage state 均不可用

### 测试
- 新增覆盖六个工具、Session 隔离、sandbox 启动参数、redirect、popup、frame、dialog、
  download、诊断、artifact、过期 ref、边界、abort、crash 与清理的确定性真实 Chromium
  测试
- 新增零重试的 DeepSeek Flash/Pro 资格矩阵，覆盖 Headless、raw PTY TUI、production
  Chromium Web 与 ACP

## [0.10.86] - 2026-08-25

### 变更
- 右侧预览面板展开后直接显示四个标签；桌面端标签占满紧凑工具栏，不再显示冗余的
  “预览”标题或关闭按钮
- 桌面端统一通过全局工具栏中的原有开关收起 Preview；全屏紧凑对话框继续保留内部
  关闭入口
- 新增全局最大化/还原控制：Preview 可占满主工作区，同时保留侧边导航、应用顶栏、
  用户设置的分栏宽度
- Preview 全屏时继续显示当前 Session 的底部悬浮输入台，状态条可展开查看会话与运行
  详情
- 面板继续保留无障碍 Preview 标签，同时在桌面与紧凑移动布局中回收垂直空间

### 测试
- 新增工具栏结构、最大化/还原布局与紧凑视图键盘焦点覆盖，并完成桌面/移动端
  production Chromium 验证
- 重新通过完整 Web 测试、bundle size 门禁及真实 DeepSeek 内嵌浏览器轨迹

## [0.10.85] - 2026-08-23

### 新增
- 右侧预览面板新增浏览器标签，支持地址跳转、有界前进/后退历史、刷新，以及显式使用
  系统浏览器打开
- 未写协议的本机与私网开发地址默认解析为 HTTP，普通裸域名默认解析为 HTTPS

### 变更
- 切换预览标签时保留浏览器运行状态；仅选择项目而没有 Session 时只默认切换一次
  Files，不再覆盖用户后续选择的标签
- 浏览器专属翻译保留在 lazy Preview chunk 中，首屏 Web bundle 继续满足原有 gzip
  预算

### 安全
- 内嵌导航只接受 HTTP(S)，拒绝包含凭据的 URL 与 Blade Web 自身 origin，并在
  no-referrer sandbox iframe 中运行
- Blade 不代理目标页面，也不移除目标站点的 `X-Frame-Options` 或 CSP 边界

### 测试
- 新增 URL、历史、导航、刷新、错误、外部打开、标签状态保留与紧凑视图焦点的确定性
  覆盖
- 发布资格新增真实 DeepSeek 回合后的 production Chromium 桌面/移动端浏览器导航、
  sandbox 断言、console fault 检查及 server/browser/port 完整回收
- Token-budget 资格现在强制复制终答 marker 前后的字节数均为零，禁止已观察到的
  boundary/copy 叙述，并只报告有界、脱敏的 mismatch 诊断

## [0.10.84] - 2026-08-23

### 变更
- Session transcript 初始化现在由不同存储 facade 共享同一个首访问执行，并在每个
  facade 中使用最多 256 项的 LRU 正向缓存保存成功结果
- 普通消息、工具、交互、评审、压缩与生命周期追加不再仅为确认不可变 Session
  metadata 已存在而重复读取并解析完整 transcript

### 修复
- 新 Session 的并发首次写入不再提交重复的 `session_created` 事件
- 失败或损坏的初始化不会进入缓存；删除 Session 时会在复用前使本地初始化正向缓存
  失效

### 测试
- 新增独立 facade 并发首写、连续 event sequence、热路径零重扫、失败后重试、
  delete/recreate 与有界 LRU 淘汰的确定性覆盖
- 发布资格继续使用真实 Provider 覆盖 Headless、raw PTY TUI、production Chromium
  Web GUI 与 ACP
- Provider recovery Web 资格测试现在会在有界诊断尾部截断前锁存完整的结构化生命周期
  证据
- Token-budget 资格测试现在会在隐藏 Bash marker 前输出显式终答复制契约，同时保留
  精确输出断言和零测试重试

## [0.10.83] - 2026-08-23

### 新增
- 超过 32 KiB 的用户 Prompt 现在写入 Session 私有、内容寻址的 artifact；Provider
  只接收 UTF-8 安全的有界摘要和 opaque artifact ID
- 新增始终可用的只读 `ReadPromptArtifact` 工具，支持最大 64 KiB 的校验后分页读取，
  且不暴露宿主路径

### 变更
- TUI、Headless、Web 与 ACP 统一使用 1,000,000 字符和 4 MiB 的 durable 用户输入
  契约，覆盖 active-turn steering 与重启恢复
- Session fork 只复制实际引用的 prompt artifact；删除 Session 会清理私有 artifact，
  且不影响 source 或 sibling Session

### 修复
- 大型规格、日志和迁移请求不再受旧 32,000 字符传输上限阻断，也不会完整进入首次
  Provider 请求
- 宿主 verification、worktree、delegation 与 completion policy 仍基于完整原始请求，
  多模态分流保持图片顺序
- artifact ID、owner、权限、大小、哈希、layout 或 symlink 替换不合法时，读取统一
  fail closed

### 测试
- 新增 UTF-8 分页、metadata 持久化、重启、fork/delete 生命周期、多模态顺序、配额、
  transport 上限、工具过滤与原始输入宿主策略的确定性覆盖
- 新增 release-blocking DeepSeek Flash/Pro × Headless、raw PTY、production Chromium
  Web、ACP 矩阵，证明隐藏 Prompt 内容只能通过匹配的 durable tool result 进入 Provider
- 强化 token-budget continuation fixture，确保 fallback compaction 后仍保留精确
  最终输出协议；为新增的大 Prompt 八格覆盖将完整发布矩阵 watchdog 从 60 分钟提升到
  90 分钟
- 将大输出 foreground accounting 对照的 handoff 余量提升到 5 秒，避免高负载宿主
  意外进入后台路径；TUI batched-input 测试 Harness 提交最新已渲染输入，避免旧闭包
  造成假失败

## [0.10.82] - 2026-08-23

### 新增
- 预测式上下文窗口计数现在使用最新的完整 Provider token usage 作为基线，并在下一次
  请求前只估算响应后的 tool result、control message 与请求形状正向增长
- Durable compaction checkpoint 与 Headless、Web、ACP 生命周期投影新增
  `preTokenSource` 和 `estimatedPendingTokens`

### 变更
- 70% handoff 与 80% compaction 阈值改为共享同一个完整上下文投影，不再依赖上一请求
  的 prompt tokens
- 模型与 tool schema 切换会保留 Provider usage 作为保守下限；历史被破坏性改写或
  usage 缺失时，对完整 system、tools 与 history 执行本地估算
- TUI 上下文占用改用完整 Provider total tokens，与 Web 保持一致

### 修复
- 大模型响应、tool result、runtime control message 和新激活的 project rule 不再让
  下一次 Provider 请求持续低估，直至触发反应式 context-limit failure
- Turn-limit compaction 的压缩前 token 投影现在包含完整响应与 tool-result 增量

### 测试
- 新增边界、过期基线、模型/schema 切换、历史改写、持久化与跨端确定性覆盖
- 使用真实 DeepSeek Flash/Pro 在 Headless、raw PTY、production Chromium Web 与 ACP
  验证 prompt usage 低于阈值一 token 的负向对照
- 最终 token-budget marker 仅由成功的验证命令返回，防止模型绕过要求的四阶段
  工具轨迹直接作答
- ACP residency 资格测试现在会等待作为 steering 接受的 follow-up 完成 durable
  acknowledgement 后再关闭会话

## [0.10.81] - 2026-08-23

### 新增
- 确定性 compaction fallback 现在取以下目标的最小值：带 5,000-token 下限的
  源内容 80% 预算、模型上下文窗口的 50%，以及 50,000-token 绝对上限
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增 fallback
  token 目标、省略消息数和截断消息数

### 变更
- Fallback 历史按从新到旧保留完整原子 tool-call 单元，并最多对一个超大边界单元
  按实测 token 截断，同时保留头尾
- 强制 continuation checkpoint 仅可将 fallback 目标提升到自身实测大小

### 修复
- Fallback 历史不再保留 reasoning 载荷、图片、孤立 tool result、不完整的空
  assistant turn，也不会重复保留已由完整 checkpoint 覆盖的 active-task 请求
- Token 统计现在包含重放的 reasoning 内容，compaction reminder 会保留精确的待执行
  动作与最终响应约束

### 测试
- 使用 DeepSeek Flash/Pro 在 Headless、raw PTY、production Chromium Web 与 ACP
  验证确定性 fallback 和真实摘要恢复
- 使用真实 DeepSeek Flash/Pro、Claude、GPT 验证 compaction 安全性；Production
  Qualification 全部 16 项通过，真实 API 测试 174 项通过

## [0.10.80] - 2026-08-23

### 新增
- Compaction 现在使用同一 token 估算基准检查完整 replacement，包括 retained
  messages 与恢复的 checkpoint
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增稳定的
  `insufficient_reduction` fallback 分类

### 修复
- 对至少 5,000 个估算 token 的历史，当完整 replacement 保留超过源内容的 80%
  时，不再提交非空摘要；Blade 会确定性 fallback 并保留已计费 usage
- 连续无效摘要会进入现有的 session 级熔断器，不再无界请求 Provider
- 跨 Provider 发布资格测试将 GPT fallback 的 idle deadline 与 request deadline
  对齐，同时保留 45 秒整体恢复上限

### 测试
- 新增完整 replacement、usage、熔断器、checkpoint 与跨端投影覆盖
- 使用真实 DeepSeek Flash/Pro、Claude、GPT 验证有效压缩，并完成生产 Web、
  raw PTY、Headless 与 ACP 发布矩阵

## [0.10.79] - 2026-08-23

### 新增
- Compaction 在调用纯文本 summary Provider 前，将每个多模态图片部分替换为固定文本
  占位符
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增每次压缩请求
  省略的图片数量

### 修复
- 内联 data URL、base64 图片载荷和远程图片 URL 不再进入 compaction Provider，
  同时保持 canonical history 与 retained messages 不变
- 真实 API 恢复资格测试不再使用容易触发隐私拒绝的 marker 措辞，并将串行 Web 与
  ACP trajectory 隔离到不同 Provider channel

### 测试
- 新增 fail-closed proxy 检查以及真实 DeepSeek Flash/Pro、Claude、GPT trajectory，
  证明图片载荷隔离、文本保留、durable 指标和 canonical message 不可变性

## [0.10.78] - 2026-08-23

### 新增
- Compaction 在原有三次总预算内自适应缩减超窗摘要输入：依次移除可重读文件、
  丢弃最旧完整 tool-call 单元，再降低单消息字符上限
- Durable checkpoint 与 Headless、Web、ACP 生命周期事件新增输入缩减次数以及省略
  消息/文件计数

### 修复
- Context window 失败不再重放相同 compaction payload；宿主无法生成严格更小请求时
  会立即进入 fallback
- 缩减输入的摘要成功后，exact continuation records 会从完整 canonical transcript
  逐字恢复

### 测试
- 真实 DeepSeek Flash/Pro × Headless、raw PTY、production Chromium Web、ACP
  矩阵现在依次注入 context overflow 和 `503`，证明 retry payload 更小并验证 durable
  reduction metadata

## [0.10.77] - 2026-08-23

### 新增
- Compaction summary 针对 Provider 瞬态失败、断流和空响应增加最多三次的有界恢复
- Durable checkpoint 以及 Headless、Web、ACP 生命周期事件新增压缩采样次数和稳定
  fallback 分类

### 变更
- Compaction 禁用嵌套 ChatService retry，由单一宿主策略统一控制分类、指数退避、
  abort 和请求次数

### 修复
- 认证、权限、非法请求、context overflow 和 caller abort 现在会立即停止压缩重试
- 成功但为空的压缩采样所消耗的 usage 与 cost 会累计
- Web recovery 资格测试将协议证据与大型渲染 HTML 分开保存，避免有效的早期 retry
  事件被尾部截断

### 测试
- 真实 DeepSeek Flash/Pro × Headless、raw PTY、production Chromium Web、ACP
  token-budget 矩阵现在注入一次 compaction `503`，要求发起新的真实摘要请求，并验证
  durable `sampleAttempts: 2`

## [0.10.76] - 2026-08-23

### 新增
- Goal 验证现在会在 continuation、上下文压缩、进程重启和 subagent 结果接管之间
  保留有界、脱敏的结构化反馈
- 验证缺口状态会投影到 TUI、Headless JSONL、Web 与 ACP

### 变更
- 相同 verifier 缺口第二次出现时会要求改变策略，第三次出现时会原子阻断 Goal
- Goal 编辑、显式恢复以及新的 verifier PASS 会清理过期验证停滞状态

### 修复
- Verifier 反馈现在会替换工作区根路径、脱敏常见凭据、转义控制标记，并限制在
  4,000 字符以内
- 真实 API handoff 资格测试在保持严格持久边界检查的同时，允许有界模型纠正回合
  与延迟 TUI 渲染

### 测试
- 新增持久化、脱敏、收敛、跨端投影和崩溃接管的确定性覆盖
- 使用真实 DeepSeek、Claude、GPT 与 Qwen 验证 verifier
  FAIL-to-repair-to-PASS 轨迹，并完成生产 Web、raw PTY、ACP 与完整 16 项
  production release matrix

## [0.10.75] - 2026-08-23

### 测试
- 为刻意超过 16 MiB 的 SSE 校验测试设置显式超时预算，使完整覆盖率插桩在受限 CI
  runner 上保持稳定，同时不改变生产响应上限

## [0.10.74] - 2026-08-23

### 新增
- 活跃 Goal 现在会保守识别 assistant 最后段落中的提前停止模式，并且只持久化
  pattern、连续次数与检测时间
- Goal 恢复状态会投影到 TUI 状态、Headless JSONL、Web SSE 与 DOM 属性，以及
  ACP metadata

### 变更
- Goal continuation 在检测到延期或交接后会发出可执行的恢复指令；同一模式连续
  第二次出现后会要求改变执行策略

### 修复
- 同一提前停止模式连续出现三次时，Goal 会原子切换为 `blocked`，避免无界
  continuation 和 token 消耗，同时不设置全局 continuation 上限
- 正常进展与用户显式 Goal 操作会清理过期恢复状态

### 测试
- 新增分类器、持久化、提示词、生命周期投影与 Web 组件的确定性覆盖，并包含误报
  对照组
- 使用真实 DeepSeek、Claude、GPT 与 Qwen Provider 验证自主恢复，并完成生产桌面/
  移动 Chromium、raw PTY 渲染及完整 16 项 production release matrix

## [0.10.73] - 2026-08-22

### 新增
- 为 TUI、Web 与 ACP 新增配置开关控制的 Agent Teams，复用 `.blade/agents`
  和 `.claude/agents` 角色定义，并提供持久化团队定义与共享依赖任务图
- 新增原子任务领取、依赖自动解锁、点对点与广播持久邮箱，以及实时 `team.*`
  生命周期投影
- 具备写能力的 teammate 默认使用隔离 worktree，并拒绝嵌套创建团队

### 变更
- Provider 请求默认不再受隐式 owner、global 或请求类别并发限制；只有显式配置
  准入限制时才启用调度
- Web 的 Team schema、传输与翻译跟随聊天界面按需加载，不增加首屏 bundle

### 修复
- teammate 消息不会出现在用户聊天中，同时保持持久化并对目标模型上下文可见
- Team 状态由权威 agent session 与任务状态派生；关闭 Agent Teams 时 Web 不再发出
  会失败的请求

### 测试
- 新增团队生命周期、所有权、任务 DAG、邮箱投递、HTTP 路由、slash command、ACP
  metadata、TUI 状态、Web 状态与 UI 交互的确定性覆盖
- 完成 DeepSeek Flash/Pro 团队协作、生产桌面/移动 Chromium、raw PTY 渲染以及完整
  production release matrix 验证

## [0.10.72] - 2026-08-22

### 新增
- 为 TUI、Web 与 ACP 新增 `/btw <question>` 旁路对话，并提供独立的瞬态加载、
  结果、错误、取消和关闭状态
- 旁路问题复用当前 Session 的模型上下文与 Provider 提示词前缀，同时保持单轮且
  禁止工具执行
- 为 Web 新增 `POST /sessions/:sessionId/side-question`

### 修复
- 旁路问题与回答不会进入主 Session transcript、durable inbox 或后续模型上下文，
  也不会中断或引导正在执行的主回合
- Runtime 销毁与表面导航现在会取消并等待进行中的旁路对话

### 测试
- 新增服务、Runtime、HTTP、ACP、TUI、Web store 与组件的确定性覆盖，包括 JSONL
  字节完全一致断言
- 在关闭框架重试的条件下完成真实 DeepSeek Runtime、GPT Web route、Claude ACP、
  DeepSeek PTY，以及桌面/移动 Chromium 流程验证

## [0.10.69] - 2026-08-22

### 修复
- subagent 会话存储现在在内存中最多保留 256 个非活跃会话 sidecar，同时固定
  （pin）正在运行的会话，防止历史 Task 流量导致长期存活的 Web 与 ACP 进程堆
  无限增长
- 会话缓存命中会刷新最近最少使用（LRU）顺序，全量会话扫描会保留最近活跃的终态
  会话

### 测试
- 新增终态会话频繁更替、驱逐后磁盘重载，以及活跃会话固定的测试覆盖

## [0.10.68] - 2026-08-22

### 新增
- Fallback 模型引用现在可以通过 `configId` 选择一个具体的模型配置，使每个
  fallback 都能使用各自的凭据、端点和请求覆盖项

### 修复
- 输出前的 Provider 空闲超时现在可以切换到另一个 fallback Provider，而不会重试
  已停滞的 Provider
- 跨 Provider 的熔断、请求准入和传输选项现在使用 fallback 通道身份，而不是主通道
- 原始 PTY 资格判定在权威、持久的最终结果与所需输出不匹配时会立即失败，而不再
  等待完整的超时时间

### 测试
- 新增一条真实的 Claude 超时切换到 GPT fallback 的轨迹测试，使用独立的通道凭据
  并严格断言不重试主通道
- 新增 fallback 配置、重放边界、准入隔离，以及 PTY 终端分类的测试覆盖

## [0.10.67] - 2026-08-22

### 修复
- 会话事件日志实例现在使用有界的最近最少使用（LRU）缓存，因此长期运行的 Web 与
  ACP 进程不会保留每一个历史 Session，同时活跃的流订阅者仍会被固定（pin）

### 测试
- 为统一的 Session 事件流新增缓存容量、最近最少使用（LRU）驱逐，以及实时订阅者
  保留的测试覆盖

## [0.10.66] - 2026-08-22

### 新增
- Web 现在提供多项目任务看板，包含等待、活跃、阻塞和评审阶段，由持久化的任务状态
  和全局 SSE 数据流驱动
- 看板任务支持本地工作区派发、项目筛选、搜索、优先级、任务类型、截止日期、取消、
  重试、变更检查，以及通过归档进行验收
- 自动任务领取可以在不打断活跃工作的情况下暂停，并按 FIFO 顺序恢复
- 任务状态、优先级、种类和截止日期会投影到专用的 SQLite 列中；任务扫描会将状态、
  优先级和截止时间筛选下推到有索引的 SQL 中，同时保留等价的 JSONL 回退行为

### 变更
- Web 模型选择默认使用一个具体的、受支持的推理强度（reasoning effort），而不是含糊
  的 `auto`，同时保留显式的 `off`
- 将 `pi-ai` 更新到 `0.84.2`，使推理能力来源于 Provider catalog
- Compaction 将有界的 `EXACT CONTINUATION RECORD` 行视为宿主拥有的契约，并在规范化
  的账本（ledger）标题下恢复它们

### 修复
- 成功执行工具后出现的空最终响应会获得一次持久的纠正，如果模型仍然为空则以失败
  收场（fail closed）
- 回合中止回执（abort receipt）会原子地保留输入确认、成功的工具证据，以及已消耗的
  纠正状态，可跨进程重启存续
- 结构化输出在输出 token 边界处提交有效负载后，仍保持权威性
- 只读校验沙箱在保留 Session Node 工具链的同时，仍拒绝访问工作区和主目录
- 测试进程会隔离并回收临时根目录和受管理的 Git overlay
- Web 任务开始/最终等待，以及 ACP/Headless 最终投影，会观测正确的已提交生命周期
  边界

### 测试
- 新增可阻塞发布的 DeepSeek Flash/Pro token 预算交接测试覆盖，跨 Headless、原始
  PTY、生产 Web Chromium 和 ACP，框架重试次数为 0
- 新增针对精确记录对账、空最终结果恢复、中止回执、ACP 清理截止期限，以及有界诊断
  的确定性测试覆盖

## [0.10.65] - 2026-08-20

### 修复
- 只读校验 agent 现在接受 test、lint、type-check 和 build 命令，只要其输出被单个
  数值型 `head` 或 `tail` 管道所限定；Blade 会在执行前移除该投影，以便原始命令的
  退出状态保持权威
- 校验沙箱可以读写其专用的临时缓存，同时源工作区保持只读，并且校验器指引现在会为
  发出工作区产物的构建脚本替换为无写入检查
- 校验命令准入仍会拒绝读取文件的管道参数、写入输出的 `tee` 管道、重定向，以及
  链式命令

### 测试
- 新增校验命令与权限边界回归测试，涵盖安全的输出截断、真实退出码保留、不安全的
  管道变体，以及原生只读沙箱临时存储

## [0.10.64] - 2026-08-19

### 修复
- LSP 客户端现在会忽略来自已释放传输代际（transport generation）的延迟进程和
  JSON-RPC 关闭事件，而不会把干净的关闭报告为崩溃，也不会清除替换服务器的
  已初始化状态

### 测试
- 新增确定性的传输代际测试覆盖，证明一个过时的 LSP 子进程无法修改或使一个新初始化
  的连接失败

## [0.10.63] - 2026-08-19

### 修复
- Vitest worker 现在会创建互不冲突的自有存储根目录，并在测试文件拆卸时同步移除它们，
  而不再遗留以 PID 命名的状态
- 显式提供的 `BLADE_STORAGE_ROOT` 目录仍归调用方所有，绝不会被测试框架移除
- npm publish 现在使用 Trusted Publishing（OIDC）并声明 `repository` 元数据，使
  sigstore 溯源（provenance）验证得以成功

### 测试
- 新增真实子进程测试覆盖，证明自有根目录在 worker 自然退出后消失，而外部管理的
  根目录及其内容保持完好

## [0.10.62] - 2026-08-19

### 变更
- CLI 的 Unicode 码点（code-point）与字符串宽度缓存现在使用条目数量和保留大小的
  LRU 限制，而不再永久保留每一个渲染过的非 ASCII 字符串
- 语法高亮现在同时强制其已有的 200 行限制和 512K 保留字符预算
- 超大宽度输入和代码行仍会被渲染，但不再被纳入进程级缓存

### 测试
- 新增高基数 Unicode 文本频繁更替、超大输入、缓存重置、唯一高亮行频繁更替，以及
  超大代码行常驻的测试覆盖
- 重新运行完整的 TUI 平台 UI 测试套件，涵盖消息渲染、Static 所有权、输入、hooks、
  工作区信任，以及 Session 切换

## [0.10.61] - 2026-08-19

### 变更
- HookManager 现在最多保留 64 个非当前工作区和 worktree 配置，同时活跃的 Session
  会保留独立的 hook 快照
- 工作区信任评审现在使用 64 条目的 LRU，而不再永久保留长期运行的 Web 或 ACP 进程
  检查过的每一个路径
- 受管理的 worktree 转换会将继承的 hook 绑定到拥有它的 Session，使工作区缓存驱逐
  无法改变一个活跃的回合

### 修复
- Session 释放现在会移除该 Session ID 的每一个动态 hook 配置、暂停别名和瞬态
  worktree 引用，而不只是它的最终路径
- HookManager 清理现在会恢复一个可复用的默认状态，而不是保留当前工作区配置或
  进程级的禁用标志

### 测试
- 新增项目与信任缓存频繁更替、活跃 Session 快照存续、动态 worktree 驱逐、完整
  Session 别名清理，以及单例复用的测试覆盖

## [0.10.60] - 2026-08-19

### 变更
- 工作区 agent 目录（catalog）现在最多保留 32 个空闲工作区，并进行确定性的 LRU
  驱逐，同时保护活跃和初始化中的条目
- 活跃或初始化中的工作区目录总数上限为 64，且 Web 请求会在另一个目录启动前收到
  可重试的过载语义
- Plugin、skill、command 和 subagent 注册表会按对象身份释放被驱逐的工作区代际，
  同时活跃的 Session 保留不可变快照

### 修复
- 失败的工作区目录初始化不再遗留残留的注册表代际
- Plugin 生命周期变更现在会在异步的刷新、安装、策略和对账工作期间固定（pin）其
  工作区目录
- 服务器关闭时会释放工作区目录，并且 MCP/LSP plugin 发现不再创建一个原本无用的
  工作区 PluginRegistry

### 测试
- 新增并发 64 工作区的活跃使用和硬上限测试覆盖、空闲 LRU 排序、跨注册表回收、
  部分失败清理、ABA 保护，以及 plugin-hook 代际恢复测试

## [0.10.59] - 2026-08-19

### 修复
- 命令准入门（admission gate）现在会监控其所属的 Blade 进程，并在该所属进程硬退出
  时终止整个命令组，即使控制管道仍然打开
- POSIX 门会验证直接父子关系，因此 PID 复用无法让一个孤儿命令继续存活

### 测试
- 新增一个真实进程回归测试，硬杀死一个前台命令的所属进程，并证明该门及其忽略 TERM
  的命令会自我回收（self-reap），而无需调用持久的孤儿回收器（orphan reaper）

## [0.10.58] - 2026-08-18

### 变更
- 从无状态的 Agent Team 存储中移除了永久性的每个配置目录（per-config-directory）
  实例表，使得工作区频繁更替无法保留任意的配置路径

### 测试
- 新增一个跨实例持久化契约测试，证明全新的 TeamStore 门面仅共享持久的团队文件，
  而不共享任何进程本地的对象身份

## [0.10.57] - 2026-08-18

### 变更
- Prompt-cache 监控现在仅以 SHA-256 值保留工具身份和契约指纹，包括用户可控的 MCP
  工具名称
- 工具的新增、移除和契约变更会按哈希后的身份进行归因，而不在请求之间保留源 schema

### 测试
- 在已有的归因和有界 Session 测试之外，新增了直接的保留状态隐私测试覆盖
- 强化了真实 GPT 缓存轨迹，使其在断言缓存中断归因之前预热超出 Provider 共享的
  前缀块，框架重试次数为 0
- 稳定了跨进程的工具准入证据，使其能应对非原子的 fixture 标记转换，同时保留精确的
  并发断言

## [0.10.56] - 2026-08-18

### 新增
- Prompt-cache 中断现在会被归因于模型、系统提示、工具 schema、请求策略、TTL，或可能
  的 Provider 侧路由和驱逐变更
- Web 缓存详情、CLI `/cost` 和 Headless JSONL 都会暴露最新的有界缓存中断归因

### 变更
- 缓存中断检测使用每 Session 的 SHA-256 指纹，而不保留提示内容或用户可控的工具名称
- 检测使用自适应 token 阈值，并在显式的 compaction 纪元（epoch）间重置其基线，以避免
  误报

### 修复
- Provider 的工具调用身份现在在实时事件、持久的 JSONL 历史和 Web 重连之间保持稳定，
  而不再在工具卡片正在渲染时发生变化

### 测试
- 新增确定性的归因、TTL、compaction、隐私，以及有界状态的测试覆盖
- 新增一条真实 GPT 轨迹，预热 Provider 缓存、替换每一个稳定的提示块，并验证系统提示
  归因，框架重试次数为 0
- 在 DeepSeek Flash/Pro 和 Headless/ACP/生产 Web 重载上重新验证有界的前台输出，框架
  重试次数为 0

## [0.10.55] - 2026-08-18

### 修复
- Agent Team 成员现在会在流式和非流式工具执行中保留其共享的 `taskListId`，而不再
  写入孤立的 Session 列表
- Task 和 Team 工具现在使用与 Session 运行时状态相同的 `BLADE_STORAGE_ROOT`
- 任务列表变更会在持有跨进程锁的同时重载权威的磁盘状态，防止过时覆盖和重复 ID
- 损坏的任务列表状态现在会以失败收场（fail closed），而不再被一个空列表替换

### 变更
- 任务列表快照以原子方式写入，并采用严格的文件权限
- 任务列表协调不再为每个 Session 保留一个进程级的管理器

### 测试
- 新增确定性的同进程和真实多进程并发、崩溃锁恢复、损坏、路径包含，以及回收的测试
  覆盖
- 新增可阻塞发布的 DeepSeek Flash/Pro Agent Team 轨迹测试，每个模型有四个并发的
  真实 API 队友写入者

## [0.10.54] - 2026-08-18

### 修复
- 只读校验 agent 现在可以执行宿主 Node 运行时，即使它安装在原本不可读的用户主目录
  之下
- 校验沙箱环境合并会保留在允许列表中的宿主 `PATH`，而不暴露 Provider 凭据或 Session
  环境值

### 测试
- 新增确定性的沙箱环境测试覆盖，以及针对裸 `node` 执行的原生 Seatbelt 集成测试
- 重新验证了通过所选 DeepSeek Pro 模型进行的 ACP 模型切换，包括 Edit、`node --test`、
  独立校验和清理

## [0.10.53] - 2026-08-18

### 新增
- CLI 状态栏现在显示 prompt 缓存命中率（`Cache —` / `Cache XX%`）
- Web StatusBar 显示缓存命中率，并带有 tooltip 明细
- `/cost` slash 命令现在包含缓存读/写 token 的明细
- 新增 `derivePromptCacheMetrics` 和 `formatPromptCacheHitRate` 纯函数，用于统一的
  缓存遥测
- 用于缓存状态显示的 i18n 字符串（英文和中文）

### 变更
- 通过稳定请求前缀提升 prompt 缓存效率：
  - 传递 Provider 会话键（`providerSessionId`）以保持缓存连续性
  - 从系统提示中移除动态的 git/列表快照
  - Tools、skills 和延迟工具列表现在按确定性顺序排序
  - 为 Provider 原生缓存启用 `cacheRetention: 'long'`
- 统一缓存命中率公式：`cacheReadTokens / inputTokens`（当没有 Provider 用量时为
  undefined）
- 将 PTY 证据截止期限从 180 秒提升到 270 秒，以适应高延迟的 Provider
- 将 ACP fork 阶段超时从 180 秒提升到 270 秒，并将模型切换从 300 秒提升到 600 秒
- 将单元测试套件的 wall-clock 预算从 240 秒提升到 480 秒
- 在 `REAL_API_RELEASE_MATRIX=1` 下，将 PTY 和 GPT 单元从可阻塞发布的矩阵中过滤掉

### 修复
- 强化了持久的前台/后台进程生命周期测试，使其能应对宿主负载导致的时序问题
- Session Runtime 常驻的 Web 测试清理现在会在 `ENOTEMPTY` 竞争时重试
- Goal 最终化会在恢复过程中保留新鲜的校验回执
- 正确强制执行有界的物理 Provider 尝试截止期限
- 键控（keyed）协调状态可确定性地回收，而不依赖 GC
