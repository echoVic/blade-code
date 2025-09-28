# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Blade is a modern TypeScript project with clear separation of concerns:

```
Root (blade-ai)
├── src/
│   ├── cli/          # CLI interface layer with React/Ink UI components
│   └── core/         # Business logic - Agent, tools, services
├── dist/blade.js     # Main executable CLI entry point
└── package.json      # Build system configuration
```

**Layer Separation:**
- **CLI Layer** (`src/cli`): Ink-based terminal UI, React components, command parsing, UI state management
- **Core Layer** (`src/core`): Business logic, Agent orchestration, tool management, IDE integration, MCP support
- **Build System**: Bun native bundling with TypeScript compilation

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
- **Develop**: `npm run dev` - Bun watch mode for CLI development
- **Build**: `npm run build` - Complete build (CLI + Core with minification)
- **Build CLI**: `npm run build:cli` - Build CLI executable only (972KB minified)
- **Build Core**: `npm run build:core` - Build core library only (389KB minified)
- **Start**: `npm run start` - Run built CLI executable
- **Clean**: Automatic cleanup before each build

### Code Quality
- **Type Check**: `npm run type-check` - TypeScript strict checking
- **Lint**: `npm run lint` - Biome linting across TypeScript files
- **Format**: `npm run format` - Biome formatting (单引号、分号、88字符行宽)
- **Check**: `npm run check` - Combined Biome linting and formatting check

### Testing
- **Test**: `npm run test` - Vitest with Jest-like API
- **Watch**: `npm run test:watch` - File-watching test runner
- **Coverage**: `npm run test:coverage` - With V8 coverage
- **Unit**: `npm run test:unit` - Unit tests only
- **Integration**: `npm run test:integration` - Integration test suite
- **E2E**: `npm run test:e2e` - End-to-end CLI testing
- **Core Only**: `npm run test:core` - Test core package only
- **Debug**: `npm run test:debug` - Verbose test output

## Package Management

**Uses pnpm** for dependency management:
- Single package structure
- Direct imports using relative paths
- All dependencies managed in root package.json

## Test Structure

```
tests/
├── unit/           # Component-level tests
├── integration/    # Multi-component workflows
├── e2e/           # Full CLI user journeys
└── security/      # Security-focused test scenarios
```

## Key Entry Points

- **CLI Entry**: `dist/blade.js` (bundled from src/cli)
- **CLI Source**: `src/cli/blade.tsx` (main CLI entry)
- **Core API**: `src/core/index.ts` (public API exports)
- **Build System**: Bun native bundling
- **Agent Core**: `src/core/agent/Agent.ts` (main Agent implementation)
- **Tool System**: `src/core/tools/ToolManager.ts` (tool registration/execution)

## Environment Variables

- `QWEN_API_KEY` - Alibaba Cloud Qwen API key
- `VOLCENGINE_API_KEY` - VolcEngine API key
- `BLADE_DEBUG` - Debug mode toggles verbose logging
- `BLADE_VERSION` - Set by build system from package.json

## Development Workflow

1. **Start dev mode**: `npm run dev` (Bun watch mode for live development)
2. **Make changes**:
   - CLI changes: Edit `src/cli/`
   - Core changes: Edit `src/core/`
   - Add new tools: `src/core/tools/`
   - Modify Agent: `src/core/agent/`
3. **Test**: `npm test` for all tests
4. **Build**: `npm run build` for production bundling (minified)
5. **Type check**: `npm run type-check` for TypeScript validation

## Build System Details

### Bun Configuration
- **Target**: Node.js ESM format
- **Minification**: Enabled for production builds
- **External dependencies**: React ecosystem, CLI tools excluded from bundle
- **Output**: Optimized single-file executables

### Build Process
```bash
# Complete build process
npm run build
# Equivalent to:
rm -rf dist && npm run build:cli && npm run build:core
```

### File Sizes (minified)
- `dist/blade.js`: 972KB (CLI executable)
- `dist/index.js`: 389KB (Core library)