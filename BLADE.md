# BLADE.md

always respond in Chinese

## 项目概述

**Blade Code** 是一个基于 React + Ink 构建的智能 AI 编程助手 CLI 工具，使用 TypeScript 开发。项目采用 **Bun workspace monorepo** 架构。

- **项目类型**: CLI 工具（TUI 应用）+ Web UI + VSCode 扩展
- **主要语言**: TypeScript
- **运行时**: Node.js >=20.0.0（开发使用 Bun 1.3.11）
- **UI 框架**: React 19 + Ink（终端 UI）/ React 19 + Vite（Web UI）
- **状态管理**: Zustand
- **配置管理**: 支持 JSON 配置和环境变量插值
- **测试框架**: Vitest
- **代码质量**: Biome（Lint + Format）
- **包管理**: Bun workspaces
- **当前版本**: 0.2.0

## 核心特性

- 🤖 智能对话，支持上下文理解和多轮对话
- 🌐 **双模式界面**：CLI 终端 + Web UI，随心切换
- 🛠️ 内置 20+ 工具（文件读写、代码搜索、Shell 执行、Git 操作等）
- 🔗 支持 Model Context Protocol (MCP)，可扩展外部工具
- 💾 会话管理（多会话、继续对话、会话 Fork）
- 🔒 多级权限系统（default/autoEdit/plan/yolo/spec）、工具白名单、操作确认
- 🎨 现代 UI，支持 Markdown 渲染和语法高亮
- 🖥️ Web UI 支持，可在浏览器中使用（0.2.0 新增）

## 关键命令

### 开发命令
```bash
bun run dev           # 启动 CLI 开发模式（watch）
bun run dev:web       # 启动 CLI 开发模式 + Web 服务器
bun run build         # 构建 CLI
```

### 运行命令
```bash
blade                 # 启动交互式 CLI
blade web             # 启动 Web UI（自动打开浏览器）
blade serve           # 启动无头服务器
blade serve --port 3000 --hostname 0.0.0.0  # 指定端口和主机
```

### 测试命令
```bash
bun run test          # 运行测试
bun run test:all      # 运行所有测试
bun run test:unit     # 运行单元测试
bun run test:cli      # 运行 CLI 测试
bun run test:coverage # 带覆盖率测试
```

### 代码质量
```bash
bun run lint          # Lint 检查
bun run lint:fix      # Lint 并自动修复
bun run type-check    # 类型检查
```

## 架构概览

### Monorepo 结构

```
Blade/
├── packages/
│   ├── cli/            # blade-code - CLI 核心工具（npm 包）
│   │   ├── src/
│   │   │   ├── agent/          # Agent 核心（无状态设计）
│   │   │   ├── tools/          # 工具系统（内置工具、执行管道、注册系统）
│   │   │   ├── server/         # Web 服务器（Hono）
│   │   │   ├── mcp/            # MCP 协议支持
│   │   │   ├── context/        # 上下文管理
│   │   │   ├── config/         # 配置管理
│   │   │   ├── ui/             # UI 组件（React + Ink）
│   │   │   ├── store/          # 状态管理（Zustand）
│   │   │   ├── services/       # 服务层（Chat、Session 等）
│   │   │   ├── commands/       # CLI 子命令（serve、web、mcp 等）
│   │   │   ├── prompts/        # 提示词
│   │   │   ├── slash-commands/ # Slash 命令
│   │   │   ├── skills/         # Skills 系统
│   │   │   ├── hooks/          # Hooks 系统
│   │   │   ├── spec/           # Spec 模式
│   │   │   └── blade.tsx       # 应用入口
│   │   └── tests/              # 测试文件
│   └── vscode/         # blade-vscode - VSCode 扩展
│       └── src/
├── docs/               # 用户文档（Docsify）
├── .blade/             # 项目级 Blade 配置
│   ├── commands/       # 自定义 Slash 命令
│   └── skills/         # 自定义 Skills
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
