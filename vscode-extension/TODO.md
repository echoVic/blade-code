# Blade Code VS Code 插件迭代计划

## 竞品分析

| 功能 | Claude Code | Cline | Roo Code | Continue.dev | Cursor | **Blade** |
|-----|-------------|-------|----------|--------------|--------|-----------|
| 侧边栏聊天 | ✓ | ✓ | ✓ | ✓ | ✓ | 📋 Phase 5 |
| 内联补全 | ✓ | ✓ | ✓ | ✓ | ✓ | 📋 Phase 6 |
| Diff 视图 | ✓ | ✓ | ✓ | ✓ | ✓ | ✅ 基础 |
| Plan 模式 | ✗ | ✓ | ✓ | ✗ | ✓ | 📋 Phase 4 |
| MCP 支持 | ✓ | ✓ | ✓ | ✓ | ✗ | ✅ CLI 侧 |
| 多文件编辑 | ✓ | ✓ | ✓ | ✓ | ✓ | 📋 Phase 3 |
| 自定义 Mode | ✗ | ✗ | ✓ | ✗ | ✗ | 📋 Phase 4 |
| 并行 Agent | ✗ | ✗ | ✗ | ✗ | ✓ | 📋 未来 |

---

## 已完成 ✅

- [x] 基础 WebSocket 服务器
- [x] 端口文件机制 (`~/.blade/ide-port`)
- [x] 核心 API：openFile, getOpenEditors, getCurrentSelection, getDiagnostics, openDiff
- [x] 状态栏显示
- [x] `/ide` 斜杠命令 (status, connect, install, disconnect)

---

## Phase 1: 稳定性与体验优化

### 连接管理
- [ ] 心跳检测机制，自动断线重连
- [ ] 多 VS Code 窗口支持（端口文件改为数组或按 workspace 区分）
- [ ] 连接状态持久化，启动时自动恢复

### 用户体验
- [ ] 插件首次激活时的欢迎页面
- [ ] 状态栏点击显示快捷菜单（启动/停止/状态）
- [ ] 连接成功/断开时的通知提示

### 错误处理
- [ ] WebSocket 连接错误的友好提示
- [ ] 端口冲突检测与自动切换
- [ ] 进程异常退出时清理端口文件

---

## Phase 2: 编辑器深度集成

### 文件操作 (参考 Cline)
- [ ] `applyEdit` - 从 CLI 直接修改文件内容（支持 Diff 预览）
- [ ] `createFile` / `deleteFile` - 文件操作
- [ ] `getFileContent` - 获取文件内容
- [ ] `revealInExplorer` - 在资源管理器中显示文件

### 智能编辑 (参考 Continue.dev AST)
- [ ] 基于 AST 的精准编辑（避免全文替换）
- [ ] 编辑成功率追踪
- [ ] 编辑回滚支持（Timeline 快照）

### 终端集成
- [ ] `runInTerminal` - 在 VS Code 终端中执行命令
- [ ] `createTerminal` - 创建新终端
- [ ] 终端输出捕获与回传

### Git 集成
- [ ] `getGitStatus` - 获取 Git 状态
- [ ] `getGitDiff` - 获取 Git diff
- [ ] `gitStage` / `gitCommit` - Git 操作

---

## Phase 3: 双向通信与事件系统

### IDE → CLI 事件推送
- [ ] 文件保存事件
- [ ] 文件切换事件 (活动编辑器变化)
- [ ] 诊断变化事件 (错误/警告更新)
- [ ] 选中文本变化事件
- [ ] 终端输出事件

### CLI 订阅机制
- [ ] `subscribe` / `unsubscribe` API
- [ ] 事件过滤器（按类型、文件路径等）

### 上下文自动收集 (参考 Cursor)
- [ ] 自动收集当前打开文件列表
- [ ] 光标位置周围代码片段
- [ ] 项目配置文件感知 (package.json, tsconfig 等)
- [ ] 最近编辑历史

---

## Phase 4: 高级功能 - Mode 系统

### 自定义 Mode (参考 Roo Code)
- [ ] 内置 Mode：Code、Architect、Ask、Debug
- [ ] 每个 Mode 独立的系统提示
- [ ] Mode 特定的工具权限（只读/可写）
- [ ] `.blademodes/` 配置文件支持

### Plan 模式 (参考 Cline)
- [ ] 执行前生成计划
- [ ] 计划编辑与确认
- [ ] 分步执行与回滚

### Boomerang 任务编排 (参考 Roo Code)
- [ ] 复杂任务分解为子任务
- [ ] 任务间上下文传递
- [ ] 任务执行历史

---

## Phase 5: 侧边栏聊天面板

### Webview 聊天界面 (参考 Cline/Continue)
- [ ] 侧边栏聊天面板
- [ ] 消息历史显示
- [ ] Markdown 渲染
- [ ] 代码块语法高亮
- [ ] 流式响应显示

### 交互增强
- [ ] @ 文件引用（自动补全）
- [ ] 斜杠命令支持
- [ ] 图片拖拽上传
- [ ] 聊天历史搜索

### 代码操作
- [ ] 代码块一键应用
- [ ] Diff 预览与确认
- [ ] 批量操作确认

---

## Phase 6: 内联功能

### 内联代码补全 (参考 Copilot/Continue)
- [ ] Tab 键触发补全
- [ ] 多候选建议
- [ ] 补全上下文感知

### 内联编辑 (参考 Cursor Cmd+K)
- [ ] 选中代码后 Cmd+K 触发
- [ ] 内联输入框
- [ ] 实时 Diff 预览
- [ ] 一键应用/拒绝

### Code Lens
- [ ] 函数级别 AI 建议
- [ ] "Ask AI"、"Optimize"、"Add Tests" 快捷操作

---

## Phase 7: 调试集成

### 调试会话
- [ ] `startDebug` - 启动调试会话
- [ ] `setBreakpoint` - 设置断点
- [ ] `getCallStack` - 获取调用栈
- [ ] `evaluateExpression` - 计算表达式

### AI 辅助调试
- [ ] 错误自动分析
- [ ] 修复建议
- [ ] 断点建议

---

## Phase 8: 生态与发布

### 发布准备
- [ ] 完善 README 和使用文档
- [ ] 添加 CHANGELOG
- [ ] 添加 LICENSE 文件
- [ ] 图标设计和截图
- [ ] VS Code Marketplace 发布

### 质量保证
- [ ] 单元测试
- [ ] E2E 测试 (vscode-test)
- [ ] CI/CD 流程

### 多 IDE 支持
- [ ] Cursor 适配
- [ ] VS Code Insiders 适配
- [ ] JetBrains IDE 插件（单独项目）

---

## 技术债务

- [ ] 移除未使用的 `setTerminalEnv` 函数中的冗余配置更新
- [ ] TypeScript 严格模式检查
- [ ] 统一错误处理格式
- [ ] 日志系统完善（支持不同级别）
- [ ] WebSocket 消息协议版本化

---

## 未来展望

### 高级特性
- [ ] 并行 Agent 支持（参考 Cursor 8 Agent）
- [ ] 语义代码搜索（Codebase 索引）
- [ ] Voice Control 语音控制
- [ ] Visual Editor 可视化编辑器

### 企业功能
- [ ] 团队配置同步
- [ ] 使用统计与分析
- [ ] 私有部署支持

---

## 参考项目

| 项目 | 特点 | 参考价值 |
|-----|------|---------|
| [Claude Code](https://claude.ai/code) | Anthropic 官方，Subagents | MCP 集成模式 |
| [Cline](https://github.com/cline/cline) | 4M+ 用户，开源透明 | Diff 编辑、Plan 模式 |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Mode 系统、Boomerang | 自定义 Mode、任务编排 |
| [Continue.dev](https://github.com/continuedev/continue) | AST 编辑、MCP 完整 | 精准编辑、MCP 配置 |
| [Cursor](https://cursor.com) | 4x 速度、8 Agent | 多 Agent、Composer |

---

## 优先级建议

**短期（1-2 周）**：Phase 1 稳定性 + Phase 2 核心编辑功能

**中期（1 月）**：Phase 3 双向通信 + Phase 5 侧边栏聊天

**长期（季度）**：Phase 4 Mode 系统 + Phase 6 内联功能
