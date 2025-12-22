# Changelog

All notable changes to this project will be documented in this file.


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
