# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Blade is a modern TypeScript project with flattened, modular architecture:

```
Root (blade-ai)
├── src/
│   ├── agent/          # Agent核心逻辑和控制器
│   ├── commands/       # CLI命令定义和处理
│   ├── config/         # 统一配置管理
│   ├── context/        # 上下文管理和压缩
│   ├── error/          # 错误处理和恢复
│   ├── ide/            # IDE集成和扩展
│   ├── logging/        # 日志系统
│   ├── mcp/            # MCP协议实现
│   ├── security/       # 安全管理
│   ├── services/       # 共享服务层
│   ├── telemetry/      # 遥测和监控
│   ├── tools/          # 工具系统
│   ├── ui/             # UI组件和界面
│   ├── utils/          # 工具函数
│   ├── index.ts        # 公共API导出
│   └── blade.tsx       # CLI应用入口
├── tests/              # 测试文件（独立）
├── dist/blade.js       # 构建后的CLI可执行文件
└── package.json        # 项目配置
```

**扁平化设计原则:**
- **模块化**: 每个目录有明确的职责边界
- **简化导入**: 减少嵌套层级，简化导入路径
- **测试分离**: 测试代码独立于源码目录
- **统一配置**: 所有配置集中管理

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
- **Develop**: `npm run dev` - Bun watch mode for live development
- **Build**: `npm run build` - Build CLI executable (0.99MB minified)
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

- **CLI Entry**: `dist/blade.js` (构建后的CLI可执行文件)
- **CLI Source**: `src/blade.tsx` (CLI应用入口)
- **Core API**: `src/index.ts` (公共API导出)
- **Build System**: Bun native bundling
- **Agent Core**: `src/agent/Agent.ts` (Agent核心实现)
- **Tool System**: `src/tools/ToolManager.ts` (工具注册/执行)
- **UI Components**: `src/ui/App.tsx` (主UI组件)
- **Config Management**: `src/config/ConfigManager.ts` (配置管理)
- **Services**: `src/services/ChatService.ts` (核心服务)

## Environment Variables

- `QWEN_API_KEY` - Alibaba Cloud Qwen API key
- `VOLCENGINE_API_KEY` - VolcEngine API key
- `BLADE_DEBUG` - Debug mode toggles verbose logging
- `BLADE_VERSION` - Set by build system from package.json

## Development Workflow

1. **Start dev mode**: `npm run dev` (Bun watch mode for live development)
2. **Make changes**:
   - CLI changes: Edit `src/blade.tsx`
   - UI changes: Edit `src/ui/`
   - Agent changes: Edit `src/agent/`
   - Add new tools: `src/tools/`
   - Config changes: `src/config/`
   - Service changes: `src/services/`
3. **Test**: `npm test` for all tests
4. **Build**: `npm run build` for production bundling (minified)
5. **Type check**: `npm run type-check` for TypeScript validation
6. **Lint**: `npm run check:fix` for code quality

## Build System Details

### Bun Configuration
- **Target**: Node.js ESM format
- **Minification**: Enabled for production builds
- **External dependencies**: React ecosystem, CLI tools excluded from bundle
- **Output**: Optimized single-file executables

### Build Process
```bash
# Single unified build
npm run build
# Equivalent to:
rm -rf dist && bun build src/blade.tsx --external react-devtools-core --external react --external react-dom --external ink --external commander --external chalk --external inquirer --minify --outfile dist/blade.js --target=node
```

### Build Output
- `dist/blade.js`: 0.99MB (Unified CLI executable)