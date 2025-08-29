# CLAUDE.md

always response in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🔧 Development Commands

Core commands for building and maintaining this TypeScript CLI tool:

```bash
# Development
npm run dev          # Watch mode development build
npm run build        # Production build with tsup
npm run start        # Run the CLI directly: node bin/blade.js

# Code Quality
npm run type-check   # TypeScript compilation check
npm run lint         # ESLint for code quality
npm run format       # Prettier for code formatting
npm run format:check # Check formatting without fixing
npm run check        # Run all quality checks combined

# Release management
npm run release              # Create new release
npm run release:dry          # Dry run release process
npm run release:patch        # Patch version bump
npm run release:minor        # Minor version bump
npm run release:major        # Major version bump
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