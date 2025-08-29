# CLAUDE.md

always response in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 📦 包管理工具

项目使用 **pnpm** 作为包管理工具，支持 Node.js 16.0.0 及以上版本。

```bash
# 安装依赖
pnpm install

# 全局安装 Blade CLI
pnpm add -g blade-ai

# 本地开发安装
pnpm link
```

## 🛠️ 技术栈

### 核心技术
- **TypeScript 5.9+**: 类型安全的 JavaScript 超集
- **Node.js 16+**: JavaScript 运行时环境
- **tsup**: 快速 TypeScript 构建工具
- **ESM**: ES 模块系统

### CLI 框架
- **Commander.js**: 命令行接口框架
- **Inquirer.js**: 交互式命令行用户界面
- **Chalk**: 终端字符串样式库
- **Ink + React**: 基于 React 的 CLI 应用构建

### AI 集成
- **OpenAI SDK**: OpenAI API 集成
- **Model Context Protocol (MCP)**: AI 模型上下文协议
- **WebSocket**: 实时通信支持

### 开发工具
- **ESLint**: 代码质量检查
- **Prettier**: 代码格式化
- **TypeScript Compiler**: 类型检查
- **ts-node**: TypeScript 直接执行

### 网络请求
- **Axios**: HTTP 客户端库

## 🔧 Development Commands

Core commands for building and maintaining this TypeScript CLI tool:

```bash
# Development
pnpm run dev          # Watch mode development build
pnpm run build        # Production build with tsup
pnpm run start        # Run the CLI directly: node bin/blade.js

# Code Quality
pnpm run type-check   # TypeScript compilation check
pnpm run lint         # ESLint for code quality
pnpm run format       # Prettier for code formatting
pnpm run format:check # Check formatting without fixing
pnpm run check        # Run all quality checks combined

# Release management
pnpm run release              # Create new release
pnpm run release:dry          # Dry run release process
pnpm run release:patch        # Patch version bump
pnpm run release:minor        # Minor version bump
pnpm run release:major        # Major version bump
```

## 🏗️ Architecture Overview

Blade is an **AI-first CLI agent** built with a component-based architecture around a central Agent class that **embeds LLM capabilities directly** rather than treating them as external components.

### Core Design Philosophy

```
Agent = LLMs + System Prompt + Context + Tools
```

This architecture allows the Agent to be the single entry point that houses AI capabilities internally, making LLM usage feel native rather than like an external service.

### Key Architecture Patterns

**1. Agent-as-Entry-Point Pattern**
- Agent class centrally coordinates LLM, tools, context management
- LLM providers (Qwen, VolcEngine) are **embedded** not external
- Components register with the Agent rather than the other way around

**2. Component-Based System**
- **LLMManager**: Houses QwenLLM and VolcEngineLLM implementations
- **ToolComponent**: Manages 25+ builtin tools (Git, file system, utilities)
- **ContextComponent**: Conversation memory and context management
- **MCPComponent**: Model Context Protocol integration
- **LoggerComponent**: Centralized logging

**3. Modular Tooling**
- Tools are organized by category (git-tools, filesystem, networking)
- Smart tools powered by LLM (code review, documentation generation)
- Security confirmation system for dangerous operations

### Key Directories & Patterns

```
src/
├── agent/            # Core Agent class and component system
│   ├── Agent.ts      # Unified agent with embedded LLM
│   ├── LLMManager.ts # Internal LLM orchestration
│   └── *.ts          # Component implementations
├── llm/              # LLM provider implementations
│   ├── BaseLLM.ts    # Abstract LLM interface
│   ├── QwenLLM.ts    # Alibaba Cloud Qwen integration
│   └── VolcEngineLLM.ts # VolcEngine/Doubao integration
├── tools/            # 25+ builtin tools
│   ├── builtin/      # Git tools, filesystem, networking
│   └── smart-tools/  # LLM-powered intelligent tools
├── context/          # Conversation memory and context
└── commands/         # CLI entry points
```

### Development Workflow

1. **Create agent**: `new Agent({ llm: { provider: 'qwen', apiKey } })`
2. **Initialize**: `await agent.init()` - sets up LLM + components
3. **Use capabilities**: Direct methods like `agent.chat()`, `agent.generateCode()`
4. **Cleanup**: `await agent.destroy()` - proper lifecycle management

### Testing Patterns

Tests focus on validating Agent behavior rather than individual LLM calls:
- Component initialization and cleanup
- Tool registration and security confirmations
- Context memory and conversation flow
- CLI command outputs

The architecture emphasizes **AI-native CLI design** where the agent is the intelligent interface, not just a wrapper around external AI services.