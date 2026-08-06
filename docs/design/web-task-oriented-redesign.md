# Web 端重构：从「聊天式」到「任务编排式」（对标 Codex app / Trae Work）

> 状态：方案评审稿（未动工）
> 目标：把当前单会话聊天界面，重构成 Codex app / Trae Work 那种「派发即走、多任务并行、产出物导向」的交互。
> 参考产品的界面细节来自实查（见第 0 节）：Codex app 为用户机器实拍截图，Trae Work 为浏览器实地访问，均非凭印象。

## 0. 参考产品真实交互（调研来源）

> 本节区分了三个**别混淆**的产品，均为查证内容，不确定处已标注。
> - **Codex app**：OpenAI 桌面客户端 —— 依据是**用户机器上的真实截图**（最可靠）。
> - **Trae Work（`work.trae.ai`）**：字节独立 Web 产品 —— 依据是**浏览器实地访问**（这是与 Blade Web 重构最贴的参照）。
> - Trae SOLO：Trae **IDE** 内的模式（桌面端），与 Trae Work 不是一回事，仅作补充参照。
> - 上一版误写的 "workbuddy" 无可靠资料，已删除。

### 0.1 Codex app（OpenAI 桌面客户端，依据：用户机器实拍截图）

界面是经典**左栏导航 + 中央 composer** 的两栏布局，核心是「项目 → 任务线程」两级嵌套，**不是 kanban 看板**：

- **左栏（顶部一级导航）**：新对话、**拉取请求**、**已安排**、插件 —— 注意 PR 和定时任务（Automations）是**顶级入口**。
- **左栏（项目区）**：列出所有项目（如 Blade、blade-deepseek…），**每个项目下嵌套该项目的任务线程**（如 blade-deepseek 下挂着"排查 goal 自动停止""分析 Orca 任务失败原因"等多条），部分线程带状态小图标。→ 多任务并行 = 侧边栏里"项目下多条线程"的**嵌套列表**。
- **中央（空状态）**：大标题"要在 **{当前项目名}** 内开发什么？" + **4 个任务类型卡片**（探索并理解代码 / 构建新功能、应用或工具 / 审查代码并提出修改建议 / 修复问题和失败）。
- **中央（输入框）**：composer 上方有 context chips —— **`{项目}` + `本地` + `main`（分支）**；右下角是模型 + 推理档（截图里是 `5.6 / 高`）+ 发送。→ 关键：有 **`本地`** chip，说明 Codex app 任务可跑在**本地**而非只有云端，这对本地单进程的 Blade 是直接的范式印证。

> 我上一版写的"Code/Ask 双按钮"是错的——真实空状态是 **4 个任务类型卡片**，输入框内另有"完全询问"切换。已据截图纠正。

### 0.2 Trae Work（`work.trae.ai`，依据：浏览器实地访问，未登录）

一个**独立的通用 AI Agent 办公 Web 工作台**（不是 IDE），页面即产品本体、非营销页。**范式与 Codex app 高度一致：左侧任务列表 + 中央大输入框，也不是 kanban**：

- **左侧可折叠栏（从上到下）**：模式切换页签 **Work / Code / Design** → 新建任务（⌘⌃N）→ 技能 → 自动化（Design 模式下变"设计系统"）→ **「任务列表」区（带筛选，未登录显示"暂无任务"）** → 底部登录。
- **中央主区（空状态）**：大标题（Work/Code/Design with TRAE）+ **居中大输入框 composer**（含斜杠命令、附件、**Auto Mode** 下拉、语音、发送）+ 下方快捷动作 chips + 示例模板卡片。
- **Code 模式专属**：composer 附近有 **「选择仓库（可选）」+「Environment」环境选择器** —— 与 Codex app 的「项目 + 本地/分支」chips 是同一类设计。
- **多任务并行 / diff / 产出**：确有「任务列表」面板与「新建任务」入口（亲眼所见）；但 **diff review、任务详情、多任务并行的具体呈现都在登录墙之后，本次未能亲见**（如实标注，不臆测）。

来源：浏览器实地访问 [work.trae.ai](https://work.trae.ai/)（未登录，只见空状态首屏 + 技能市场）。

### 0.3 Trae SOLO（Trae IDE 内模式，补充参照，依据：官方文档 + 第三方评测）

与 Trae Work 不是一个产品，但它公开的**三栏布局**值得借鉴，且有官方文档佐证：

- **三栏**（官方文档原话）：左 **多任务窗口/任务管理面板** | 中 **对话流** | 右 **工具面板**（编辑器/文档/终端/浏览器/**DiffView**/Figma 等）。
- **多任务**：可同时开多个对话并行（如 Builder 发新功能 + Coder 重构 + sub-agent 更文档），切换/新建/重命名任务。
- **DiffView**：会话底部统一看代码改动（文件数 + 变更行数 + 文件列表），可筛选、可回溯。
- **实时跟随 / Plan 先行**：按 agent 阶段自动切工具面板；SOLO Coder 先出 plan 待确认再执行。

来源：[SOLO mode overview（官方文档）](https://docs.trae.ai/ide/solo-mode?_lang=en)、[工具面板（官方文档）](https://docs.trae.ai/ide/tool-panels)、[SOLO GA 博客](https://www.trae.ai/blog/product_solo_1112)。

### 0.4 对 Blade 的启示（三者的共识 → 直接可借鉴）

三个产品的**共同范式**（这才是要抄的）：**左侧任务/线程列表（非 kanban）+ 中央 composer 派发 + 派发后进详情看对话与 diff**。

| 借鉴点 | 来自（真实观察） | 对应到 Blade 的动作 |
|---|---|---|
| 左侧「任务列表」而非 kanban 分列 | Codex 线程嵌套 + Trae Work 任务列表（均亲见） | Sidebar 升级为任务列表（缺口 3，**已据实修正，不做 kanban**） |
| 中央 composer + 任务类型卡片引导 | Codex 4 卡片 / Trae Work chips（均亲见） | 新建任务入口（缺口 3） |
| context chips：项目/仓库 + 本地 + 分支 | Codex「项目+本地+main」/ Trae Work「选择仓库+Environment」 | 建任务时选 worktree/分支（缺口 4） |
| 派发即走 + 后台跑 + 实时进度 | Codex Cloud | 已有（202 + SSE），补全局流（缺口 1） |
| 产出物导向（diff 文件数+行数 / PR） | Codex 日志引用 + Trae DiffView | 任务态归档 diffStat/artifact（缺口 2） |
| PR / 定时任务作为顶级入口 | Codex 左栏「拉取请求」「已安排」 | 后续可加（非 MVP） |

## 1. 结论先行

**可行，属于「后端小改 + 前端中大改」，不是重写。**

原因：Blade 后端的执行模型本来就是异步任务式的——`POST /message` 立即返回 202，agent 在 `executeRunAsync` 后台跑，前端断连不中断（见 `packages/cli/src/server/routes/session.ts:440-535`）。codex/trae 那套交互缺的主要是**前端范式**和**几个聚合接口**，核心执行链路不用推倒。

### 范式差异的本质

| 维度 | 当前 Blade Web（聊天式） | 目标（任务编排式） |
|---|---|---|
| 心智模型 | 一个对话框来回聊 | 派发任务 → 任务卡片进列表 → 各自后台跑 |
| 并行 | 侧边栏串行切换会话 | 多任务并行，任务列表实时看状态 |
| 环境 | 默认共享工作区 | 每任务独立分支/worktree |
| 产出 | 消息流里翻 diff | 任务完成 → 归档 diff / PR，一键 review |
| 实时 | per-session SSE | 全局事件流驱动任务列表 + per-session 详情流 |

## 2. 现有资产盘点（能直接复用的）

- **异步后台执行**：`session.ts:440-535`，断连 run 不中断。✅ 这是「派发即走」的地基。
- **多 session 并行**：模块级 `sessions` Map（`session.ts:80`）+ JSONL 持久化；跨进程有 `SessionLease` 文件锁防抢占。✅
- **每任务独立环境**：`WorktreeManager`（`packages/cli/src/worktree/WorktreeManager.ts`）+ subagent 已在用自动 worktree 做并行隔离。✅ 现成底座。
- **全局事件总线**：`Bus`（`packages/cli/src/server/bus.ts`）本就是全局单例 EventEmitter，`publish(sessionId, type, props)`。✅ 全局流几乎免费。
- **review 组件齐全**：`FilePreview.tsx`（Diff/Files/Logs 三 Tab）、`ChatMessage.tsx`（权限确认卡片含 diff、任务进度、subagent 进度）。✅
- **Zustand slice 架构**：`web/src/store/session/`（session / message / streaming / ui 四 slice）。✅ 详情页可整体复用。

## 3. 关键缺口（4 个，按成本排序）

### 缺口 1：全局事件流（小改，必做）
现状：SSE 是 per-session 的 `GET /sessions/:id/events`（`session.ts:373-438`），只推匹配 `sessionId` 的事件。任务列表首页要实时看到「所有任务」状态跳动，缺一个全局流。

方案：新增 `GET /events`（不按 sessionId 过滤，直接转发 `Bus` 所有事件）。因为 `Bus.subscribe` 回调本就拿到全量事件，去掉过滤即可。前端首页订阅它刷新任务列表状态。

### 缺口 2：任务态语义 + 元数据（中改）
现状：`SessionMetadata`（`SessionService.ts:27-41`）只有 `status?: 'running' | 'completed' | 'failed'`，缺任务生命周期与产出归档。

方案：扩展任务态：
```
queued → running → needs_review → done
                 ↘ failed / cancelled
```
在 session 元数据上补：`taskStatus`、`prompt`（原始需求摘要）、`worktreeBranch`、`diffStat`（+/- 行数）、`artifactRef`（PR 链接 / patch 路径）。持久化落到 JSONL 的 `session_updated` 事件（已有该事件类型，见 `SessionService.ts:307`）。

### 缺口 3：前端范式重构（中大改，可复用）
现状：`web/src/App.tsx` 就是 `<Layout><ChatView /></Layout>`，无路由（无 react-router）。

方案：对标三产品共识范式 —— **左侧任务列表（非 kanban）+ 中央 composer 派发 + 详情页三栏**，落成两级视图：

- 引入轻量路由（react-router 或自建 hash 路由）：
  - `/`（或 `/tasks`）：**任务首页**——中央一个大 composer 作为派发核心（对标 Codex/Trae Work 的居中输入框）+ 空状态给几张**任务类型卡片**引导（对标 Codex 的 4 卡片）；左侧是**任务列表**（对标 Codex「项目→线程」嵌套 / Trae Work「任务列表」，按状态分组 queued/running/needs_review/done，非分列看板），列表项显示标题、状态 pill、diffStat（对标 Trae DiffView 的「文件数 + 变更行数」）、耗时。
  - `/tasks/:id`：**任务详情**——采用 SOLO 式**三栏**：左「任务列表」（复用升级后的 Sidebar）+ 中「对话流」（复用现有 `ChatView`）+ 右「工具面板」（复用现有 `FilePreview` 的 Diff/Files/Logs）。
- composer 上带 **context chips**：仓库/项目 + `本地` + 分支（对标 Codex「项目+本地+main」、Trae Work「选择仓库+Environment」），直接驱动缺口 4 的 worktree 选择。
- 新增 store slice：`taskListSlice`（任务列表 + 全局 SSE 订阅 + 状态聚合），与现有 session slice 并存。
- `Sidebar` 从「历史会话列表」升级为「任务列表面板」：按状态分组 + 各自进度实时刷新。
- **可选（非 MVP）对标 Trae「实时跟随」**：详情页右侧工具面板按 agent 当前阶段自动切 Tab（写文件→Diff、跑命令→Logs），Blade 事件流已有 `tool.start`/阶段信息，具备实现基础。

### 缺口 4：每任务自动进 worktree（策略改）
现状：worktree 靠 LLM 显式调 `EnterWorktree`，工具描述明确写 "Never enter a worktree unless the user explicitly requested"（`packages/cli/src/tools/builtin/worktree/worktreeTools.ts`）。

方案：新建任务时提供「隔离模式」开关（默认可配）。开启则创建 session 时自动 `worktreeManager.enter({ sessionId, workspaceRoot })`，并把分支名写入元数据。不改 LLM 工具语义，只在 server 建任务入口处编排。

## 4. 必须正视的取舍（本地 vs 云端）

codex 是**云端多机**并行；Blade 是**本地单进程**。据此有三条硬约束必须在方案里兜住：

1. **资源竞争**：多任务并行抢本地 CPU / API 配额 / 同一 repo 的 git 操作。worktree 隔离了文件，但 API 限流和 git 全局锁仍需串行化或加并发上限（建议默认并发 2-3，可配）。
2. **进程存活**：「关掉浏览器任务还在跑」依赖 server 常驻——`blade serve` headless 已支持。✅ 但整进程被杀则内存 `activeRuns` 丢失（JSONL 只存了消息、没存 run 态）。**需补断点：** 进程重启后扫描 JSONL 中 `taskStatus=running` 的 session，标记为 `interrupted` 并提供「续跑」。
3. **worktree GC**：并行任务多了孤儿 worktree 风险上升。现有 `cleanupStaleAgentWorktrees`（`SessionRuntime.ts:52-81`）清 30 天 `agent+` worktree，需扩展到任务型 worktree。

## 5. 分阶段实施计划

### Phase 0 — 后端聚合能力（1-2 天，低风险）
- [ ] 新增 `GET /events` 全局事件流（缺口 1）。
- [ ] 扩展 `SessionMetadata` 任务态字段 + `GET /sessions` 返回这些字段（缺口 2）。
- [ ] 新增 `POST /tasks`（= 建 session + 可选自动 enter worktree + 写初始 prompt，一步到位）。
- 验收：curl `/events` 能收到跨 session 事件；`/sessions` 返回 taskStatus/diffStat。

### Phase 1 — 前端任务列表 MVP（3-5 天）
- [ ] 引入路由，`App.tsx` 拆成任务首页 + 详情页。
- [ ] `taskListSlice`：订阅 `/events`，聚合任务列表状态。
- [ ] 任务首页：中央 composer + 左侧任务列表（状态分组）。
- [ ] 详情页复用 `ChatView` + `FilePreview`。
- 验收：首页派发两个任务，都在后台跑，列表状态实时跳动，点进详情看流式。

### Phase 2 — 隔离与产出物（3-5 天）
- [ ] 建任务时「隔离模式」开关 → 自动 worktree（缺口 4）。
- [ ] 任务完成聚合 diffStat / patch，详情页「Review」入口。
- [ ] 并发上限 + API 限流。
- 验收：并行任务各在独立分支，互不污染；完成后一键看整体 diff。

### Phase 3 — 健壮性（2-3 天）
- [ ] 进程重启断点恢复（running → interrupted → 续跑）。
- [ ] worktree GC 扩展到任务型。
- [ ] 任务列表筛选/搜索/批量操作。

## 6. 涉及文件清单

**后端：**
- `packages/cli/src/server/bus.ts` — 全局流基础，可能加带 filter 的 subscribe 变体。
- `packages/cli/src/server/routes/session.ts` — 新增 `/events`、`/tasks`；扩展 status 上报。
- `packages/cli/src/services/SessionService.ts` — `SessionMetadata` 扩展 + 持久化。
- `packages/cli/src/worktree/WorktreeManager.ts` — 建任务自动 enter 的编排入口。
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — GC 扩展。

**前端：**
- `packages/cli/web/src/App.tsx` — 引入路由，拆双层视图。
- `packages/cli/web/src/store/session/` — 新增 `taskListSlice`。
- `packages/cli/web/src/components/` — 新增 `tasks/`（任务首页、任务列表项、composer）；复用 `chat/`、`preview/`。
- `packages/cli/web/src/services/sessionService.ts` — 新增全局 SSE 订阅 + `/tasks` 调用。

## 7. 工作量估算

| 阶段 | 预估 | 风险 |
|---|---|---|
| Phase 0 后端 | 1-2 天 | 低（复用 Bus + 加字段） |
| Phase 1 任务列表 MVP | 3-5 天 | 中（前端范式改 + 引路由） |
| Phase 2 隔离产出 | 3-5 天 | 中（worktree 编排 + 并发控制） |
| Phase 3 健壮性 | 2-3 天 | 中（断点恢复需测进程崩溃场景） |
| **合计** | **约 2-3 周** | 可先交付 Phase 0+1 的 MVP 验证方向 |
