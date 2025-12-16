# BLADE.md

always respond in Chinese

你是一个专门帮助 Blade Code CLI 工具开发者的助手。

## 项目概述

**Blade Code** 是一个基于 TypeScript 开发的智能 AI 编程助手 CLI 工具，使用 Ink (React for CLI) 构建现代化的终端界面。项目采用模块化架构，核心是无状态的 Agent 设计，配合 Hook 系统实现可插拔的扩展机制。

- **语言**: TypeScript (ESM)
- **运行时**: Node.js >=16.0.0
- **包管理器**: Bun (主), 兼容 pnpm
- **UI 框架**: Ink + React 19
- **构建工具**: Bun 内置构建器
- **测试框架**: Vitest

## 核心架构

### 1. Agent 系统 (`src/agent/`)
- **Agent.ts**: 核心 Agent 类，无状态设计，负责 LLM 交互和工具执行
- **ExecutionEngine.ts**: 执行引擎，处理工具调用循环
- **Agent.ts**: Agentic Loop 主循环，使用 `maxTurns` + 硬性轮次上限 `SAFETY_LIMIT = 100` 防止无限循环（旧版 LoopDetectionService 已移除）
- **subagents/**: 子 Agent 注册表，支持任务分解

### 2. Hook 系统 (`src/hooks/`)
可插拔的扩展机制，支持在工具执行前后插入自定义逻辑：
- **HookManager.ts**: 单例管理器，负责 Hook 配置和执行
- **HookExecutor.ts**: Hook 执行器
- **Matcher.ts**: 匹配器，决定 Hook 是否触发
- **SecureProcessExecutor.ts**: 安全进程执行器

### 3. Context 管理 (`src/context/`)
统一管理会话和上下文：
- **ContextManager.ts**: 核心上下文管理器，支持内存/持久化存储
- **CompactionService.ts**: 上下文压缩服务，防止 token 超限
- **TokenCounter.ts**: Token 计数器

### 4. Tool 系统 (`src/tools/`)
- **builtin/**: 内置工具（文件操作、Git、网络等）
- **registry/**: 工具注册表
- **execution/**: 工具执行管线
- **validation/**: 工具参数验证
- **MCP 集成**: 支持 Model Context Protocol 扩展

### 5. 服务层 (`src/services/`)
- **OpenAIChatService.ts**: OpenAI API 服务
- **AnthropicChatService.ts**: Anthropic API 服务
- **SessionService.ts**: 会话管理服务

### 6. Slash 命令 (`src/slash-commands/`)
- **builtinCommands.ts**: 内置命令（/compact, /init, /model 等）
- **UIActionMapper.ts**: UI 动作映射器

### 7. MCP 集成 (`src/mcp/`)
- **McpRegistry.ts**: MCP 注册表
- **McpClient.ts**: MCP 客户端
- **loadProjectMcpConfig.ts**: 项目 MCP 配置加载

### 8. UI 层 (`src/ui/`)
- **App.tsx**: 主应用组件
- **components/**: UI 组件（BladeInterface, LoadingIndicator 等）
- **contexts/**: React Context（SessionContext, AppContext 等）

### 9. 配置系统 (`src/config/`)
- **ConfigManager.ts**: 配置管理器
- 支持多层级配置（默认 → 用户 → 环境变量）

### 10. CLI 层 (`src/cli/`, `src/commands/`)
- **blade.tsx**: 入口文件
- **commands/**: 命令实现（config, doctor, mcp, update 等）

## 开发命令

### 构建与运行
```bash
# 开发模式（热重载）
bun run dev

# 构建生产版本
bun run build

# 运行构建后的版本
bun run start

# 清理构建产物
bun run clean
```

### 测试
```bash
# 运行所有测试
bun run test:all

# 单元测试
bun run test:unit

# 集成测试
bun run test:integration

# CLI 测试
bun run test:cli

# 覆盖率测试
bun run test:coverage

# 监听模式
bun run test:watch

# CI 模式（带覆盖率）
bun run test:ci
```

### 代码质量
```bash
# 检查代码
bun run check

# 自动修复
bun run check:fix

# 格式化
bun run format

# 格式化检查
bun run format:check

# 类型检查
bun run type-check

# 完整检查（类型 +  lint + 格式化 + 测试）
bun run check:full
```

### 安全
```bash
# 安全审计
bun run security:audit

# 安全测试
bun run security:test
```

### 发布
```bash
# 发布新版本（自动判断版本号）
bun run release

# 预览发布
bun run release:dry

# 指定版本号
bun run release:major
bun run release:minor
bun run release:patch
```

### MCP 相关
```bash
# 下载 ripgrep（用于文件搜索）
bun run vendor:ripgrep

# 清理 ripgrep
bun run vendor:ripgrep:clean
```

### 预检（发布前运行）
```bash
bun run preflight
```

## 关键设计模式

### 1. 无状态 Agent
Agent 实例不保存会话状态，所有状态通过 context 参数传入。每次命令可以创建新实例，用完即弃。

### 2. Hook 系统
- 支持 pre/post tool use Hook
- 基于模式匹配触发
- 可配置执行策略（顺序、并行、短路）

### 3. Context 管理
- 三层存储：内存 → 缓存 → 持久化
- 自动压缩防止 token 超限
- 支持向量搜索（可选）

### 4. Tool 执行管线
- 参数验证 → Hook 前置 → 执行 → Hook 后置 → 结果处理
- 支持同步/异步工具
- 自动错误处理

### 5. 配置优先级
环境变量 > 用户配置 > 默认配置

## 开发指南

### 添加新工具
1. 在 `src/tools/builtin/` 创建工具文件
2. 实现 Tool 接口
3. 在 `src/tools/builtin/index.ts` 注册

### 添加新 Hook
1. 实现 Hook 接口
2. 在 HookManager 中注册
3. 配置触发规则

### 添加新 Slash 命令
1. 在 `src/slash-commands/` 创建命令文件
2. 实现命令处理器
3. 在 `src/slash-commands/builtinCommands.ts` 注册

### 添加新 MCP 服务器
1. 在项目根目录创建 `.blade/mcp.json`
2. 配置服务器连接信息
3. 工具自动加载

## 重要注意事项

1. **ESM 模块**: 项目使用 ESM，导入语句必须包含 `.js` 扩展名
2. **类型安全**: 严格 TypeScript 配置，避免使用 `any`
3. **错误处理**: 所有异步操作需要适当的错误处理
4. **安全**: 工具执行需要权限验证，敏感操作需要用户确认
5. **性能**: 注意 token 使用，大文件操作需要流式处理
6. **测试**: 新功能必须包含测试用例
7. **文档**: 公共 API 需要 JSDoc 注释

## 项目结构
```
src/
├── agent/          # Agent 核心
├── cli/            # CLI 配置
├── commands/       # 命令实现
├── config/         # 配置管理
├── context/        # 上下文管理
├── hooks/          # Hook 系统
├── ide/            # IDE 集成
├── logging/        # 日志系统
├── mcp/            # MCP 集成
├── prompts/        # 提示词管理
├── services/       # 服务层
├── slash-commands/ # Slash 命令
├── tools/          # 工具系统
├── ui/             # UI 组件
└── utils/          # 工具函数
```
