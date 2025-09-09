# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Blade is a modern TypeScript monorepo architected with clear separation of concerns:

```
Root (blade-ai)
├── packages/
│   ├── cli/          # CLI interface layer with React/Ink UI components
│   ├── core/         # Business logic - Agent, tools, services
│   └── types/        # Shared TypeScript definitions (now integrated into core)
├── bin/blade.js      # Main executable CLI entry point
└── esbuild.config.js # Build system configuration
```

**Layer Separation:**
- **CLI Layer** (`@blade-ai/cli`): Ink-based terminal UI, React components, command parsing, UI state management
- **Core Layer** (`@blade-ai/core`): Business logic, Agent orchestration, tool management, IDE integration, MCP support
- **Build System**: Custom esbuild bundling with dual-package TypeScript compilation

## Core Components Architecture

### Agent System
- **Agent**: Main orchestrator for LLM interactions with context/memory management and enhanced steering control
- **ToolManager**: Centralized tool registration/execution system with validation and security controls
- **IDE Integration**: Multi-IDE detection and extension installation via IdeContext/IdeInstaller
- **MCP Support**: Model Context Protocol server/client integration for external tools
- **ChatService**: Unified LLM interface supporting multiple providers (Qwen, VolcEngine, OpenAI, Anthropic)

### Key Services
- **FileSystemService**: File operations with atomic transactions and security validation
- **GitService**: Git repository operations and analysis  
- **TelemetrySDK**: Metrics collection and error tracking
- **ProxyService**: HTTP client with retry/batch capabilities and security controls
- **ConfigManager**: Hierarchical configuration management with encryption support

## Build & Development Commands

### Quick Commands
- **Develop**: `npm run dev` - TSC watch mode for packages
- **Build**: `npm run build` - Full monorepo build via esbuild.config.js
- **Bundle**: `npm run build:bundle` - CLI bundling with tree-shaking
- **Clean**: `npm run clean` - Remove dist/ and bundles/

### Code Quality
- **Type Check**: `npm run type-check` - TypeScript strict checking
- **Lint**: `npm run lint` - ESLint across TypeScript files
- **Format**: `npm run format` - Prettier formatting
- **Check**: `npm run check` - Combined type/lint/format check

### Testing
- **Test**: `npm run test` - Vitest with Jest-like API
- **Watch**: `npm run test:watch` - File-watching test runner
- **Coverage**: `npm run test:coverage` - With V8 coverage
- **Unit**: `npm run test:unit` - Unit tests only
- **Integration**: `npm run test:integration` - Integration test suite
- **E2E**: `npm run test:e2e` - End-to-end CLI testing
- **Core Only**: `npm run test:core` - Test core package only
- **Debug**: `npm run test:debug` - Verbose test output

### Package-Specific Commands
```bash
# Core package
cd packages/core && npm run build      # Core library build
npm run test:core                     # Test core package only

# CLI package
cd packages/cli && npm run build      # CLI library build
cd packages/cli && npm run build:bundle # CLI bundling only

# Build all packages
npm run build:packages                # Build all packages in sequence
```

## Package Management

**Uses pnpm workspaces** for monorepo management:
- Workspace packages: `cli/`, `core/`
- Cross-package imports use `@blade-ai/*` aliases
- Type definitions now integrated into `@blade-ai/core` package

## Test Structure

```
tests/
├── unit/           # Component-level tests
├── integration/    # Multi-component workflows
├── e2e/           # Full CLI user journeys
└── security/      # Security-focused test scenarios
```

## Key Entry Points

- **CLI Entry**: `bin/blade.js` (bundled from packages/cli)
- **CLI Source**: `packages/cli/src/blade.tsx` (main CLI entry)
- **Core API**: `packages/core/src/index.ts` (public API exports)
- **Build Script**: `esbuild.config.js` (Node.js-based bundling)
- **Agent Core**: `packages/core/src/agent/Agent.ts` (main Agent implementation)
- **Tool System**: `packages/core/src/tools/ToolManager.ts` (tool registration/execution)

## Environment Variables

- `QWEN_API_KEY` - Alibaba Cloud Qwen API key
- `VOLCENGINE_API_KEY` - VolcEngine API key
- `BLADE_DEBUG` - Debug mode toggles verbose logging
- `BLADE_VERSION` - Set by build system from package.json

## Development Workflow

1. **Start dev mode**: `npm run dev` (type-check watching)
2. **Make changes**:
   - CLI changes: Edit `packages/cli/src/`
   - Core changes: Edit `packages/core/src/`
   - Add new tools: `packages/core/src/tools/`
   - Modify Agent: `packages/core/src/agent/`
3. **Test**: `npm test` or `npm run test:core`
4. **Build**: `npm run build` for full bundling