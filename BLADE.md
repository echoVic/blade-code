# BLADE.md

always respond in Chinese

## 项目概述

**Blade Code** 是一个基于 React + Ink 构建的智能 AI 编程助手 CLI 工具，使用 TypeScript 开发。项目采用 **pnpm workspace monorepo** 架构。

- **项目类型**: CLI 工具（TUI 应用）+ Web UI + VSCode 扩展
- **主要语言**: TypeScript
- **运行时**: Node.js >=20.0.0（开发使用 Bun）
- **UI 框架**: React 18 + Ink（终端 UI）/ React 18 + Vite（Web UI）
- **状态管理**: Zustand
- **配置管理**: 支持 JSON 配置和环境变量插值
- **测试框架**: Vitest
- **代码质量**: Biome（Lint + Format）
- **包管理**: pnpm workspace

## 核心特性

- 🤖 智能对话，支持上下文理解和多轮对话
- 🛠️ 内置 18+ 工具（文件读写、代码搜索、Shell 执行、Git 操作等）
- 🔗 支持 Model Context Protocol (MCP)，可扩展外部工具
- 💾 会话管理（多会话、继续对话、会话 Fork）
- 🔒 三级权限系统（allow/ask/deny）、工具白名单、操作确认
- 🎨 现代 UI，支持 Markdown 渲染和语法高亮
- 🌐 Web UI 支持，可在浏览器中使用

## 关键命令

### 开发命令
```bash
pnpm dev              # 并行启动所有包的开发模式
pnpm dev:cli          # 仅启动 CLI 开发模式
pnpm dev:web          # 仅启动 Web UI 开发模式
pnpm build            # 构建所有包
pnpm build:cli        # 仅构建 CLI
pnpm build:web        # 仅构建 Web UI
```

### 测试命令
```bash
pnpm test             # 运行测试
pnpm test:all         # 运行所有测试
pnpm test:unit        # 运行单元测试
pnpm test:cli         # 运行 CLI 测试
pnpm test:coverage    # 带覆盖率测试
```

### 代码质量
```bash
pnpm lint             # Lint 检查
pnpm format           # 格式化代码
pnpm type-check       # 类型检查
pnpm preflight        # 全面检查（清理、安装、格式化、Lint、构建、类型检查、测试）
```

## 架构概览

### Monorepo 结构

```
Blade/
├── packages/
│   ├── cli/            # @blade/cli - CLI 核心工具
│   │   ├── src/
│   │   │   ├── agent/          # Agent 核心（无状态设计）
│   │   │   ├── tools/          # 工具系统（内置工具、执行管道、注册系统）
│   │   │   ├── mcp/            # MCP 协议支持
│   │   │   ├── context/        # 上下文管理
│   │   │   ├── config/         # 配置管理
│   │   │   ├── ui/             # UI 组件（React + Ink）
│   │   │   ├── store/          # 状态管理（Zustand）
│   │   │   ├── services/       # 服务层
│   │   │   ├── cli/            # CLI 相关
│   │   │   ├── commands/       # 命令处理
│   │   │   ├── prompts/        # 提示词
│   │   │   ├── utils/          # 工具函数
│   │   │   ├── slash-commands/ # Slash 命令
│   │   │   └── blade.tsx       # 应用入口
│   │   └── tests/              # 测试文件
│   ├── web/            # @blade/web - Web UI 前端
│   │   └── src/
│   ├── vscode/         # @blade/vscode - VSCode 扩展
│   │   └── src/
│   └── shared/         # @blade/shared - 共享代码
│       └── src/
├── docs/               # 文档
├── pnpm-workspace.yaml # Workspace 配置
├── tsconfig.base.json  # 共享 TypeScript 配置
└── package.json        # 根 package.json
```

### 核心设计原则

1. **无状态 Agent 设计**: Agent 本身不保存会话状态，所有状态通过 context 参数传入
2. **工具系统**: 统一的工具注册、执行、验证系统，支持内置工具和 MCP 扩展
3. **权限控制**: 三级权限系统（allow/ask/deny），支持工具白名单和操作确认
4. **会话管理**: 支持多会话、会话恢复、会话 Fork

## 开发指南

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 Biome 配置的代码风格（单引号、分号、88 字符行宽）
- 尽量避免使用 `any` 类型
- 所有工具参数使用 Zod Schema 定义

### 测试要求

- 新功能需要添加相应的单元测试
- 测试文件位于 `packages/cli/tests/` 目录
- 使用 Vitest 作为测试框架

### 文档结构

- `docs/` - 用户文档（Docsify 站点）

## 更多信息

- [README.md](README.md) - 项目说明
- [CONTRIBUTING.md](CONTRIBUTING.md) - 贡献指南
- [docs/](docs/) - 详细文档
