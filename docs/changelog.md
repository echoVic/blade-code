# Changelog

All notable changes to this project will be documented in this file.

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
