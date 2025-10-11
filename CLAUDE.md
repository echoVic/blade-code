# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Blade is a modern TypeScript project with flattened, modular architecture:

```
Root (blade-code)
├── src/
│   ├── agent/          # Agent核心逻辑和控制器
│   ├── cli/            # CLI配置和中间件
│   ├── commands/       # CLI命令定义和处理
│   ├── config/         # 统一配置管理
│   ├── context/        # 上下文管理和压缩
│   ├── error/          # 错误处理和恢复
│   ├── ide/            # IDE集成和扩展
│   ├── logging/        # 日志系统
│   ├── mcp/            # MCP协议实现
│   ├── prompts/        # 提示模板管理
│   ├── security/       # 安全管理
│   ├── services/       # 共享服务层
│   ├── slash-commands/ # 内置斜杠命令
│   ├── telemetry/      # 遥测和监控
│   ├── tools/          # 工具系统
│   ├── ui/             # UI组件和界面（基于Ink）
│   ├── utils/          # 工具函数
│   ├── index.ts        # 公共API导出
│   └── blade.tsx       # CLI应用入口
├── tests/              # 测试文件（独立）
│   ├── unit/           # 组件级测试
│   ├── integration/    # 多组件工作流测试
│   ├── e2e/            # 端到端CLI测试
│   └── security/       # 安全测试
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
- **Agent** ([src/agent/Agent.ts](src/agent/Agent.ts)): 主要协调器，管理LLM交互、上下文/记忆和执行控制
  - 静态工厂方法 `Agent.create()` 用于创建和初始化实例
  - 通过 `ExecutionEngine` 处理工具执行流程
  - 通过 `LoopDetectionService` 防止无限循环
- **ToolRegistry** ([src/tools/registry/ToolRegistry.ts](src/tools/registry/ToolRegistry.ts)): 中心化工具注册/执行系统，提供验证和安全控制
- **ChatService** ([src/services/ChatService.ts](src/services/ChatService.ts)): 统一LLM接口，支持多提供商（基于OpenAI客户端）
  - 支持流式和非流式响应
  - 内置重试机制和错误处理
  - 工具调用集成

### Key Services
- **ConfigManager** ([src/config/config-manager.ts](src/config/config-manager.ts)): 分层配置管理，支持加密
  - 配置优先级：命令行参数 > 环境变量 > 用户配置 > 全局配置 > 默认值
- **PromptBuilder** ([src/prompts/](src/prompts/)): 提示模板管理和构建

## Build & Development Commands

### Quick Commands

- **开发模式**: `npm run dev` - Bun watch 模式，实时开发
- **构建**: `npm run build` - 构建 CLI 可执行文件（~1MB minified）
- **运行**: `npm run start` - 运行构建后的 CLI
- **清理**: `npm run clean` - 清理构建产物和缓存

### Code Quality

- **类型检查**: `npm run type-check` - TypeScript 严格类型检查
- **Lint**: `npm run lint` - Biome 代码检查
- **格式化**: `npm run format` - Biome 格式化（单引号、分号、88字符行宽）
- **综合检查**: `npm run check` - Biome lint + format 检查
- **自动修复**: `npm run check:fix` - 自动修复 lint 和格式问题

### Testing

- **运行测试**: `npm test` - 使用 Vitest 运行所有测试
- **监视模式**: `npm run test:watch` - 文件变化时自动运行测试
- **覆盖率**: `npm run test:coverage` - 生成 V8 覆盖率报告
- **单元测试**: `npm run test:unit` - 仅运行单元测试
- **集成测试**: `npm run test:integration` - 仅运行集成测试
- **端到端测试**: `npm run test:e2e` - 仅运行 E2E 测试
- **性能测试**: `npm run test:performance` - 运行性能测试
- **调试模式**: `npm run test:debug` - 详细输出模式

### Release Commands

- **版本发布**: `npm run release` - 自动发布新版本
- **预发布检查**: `npm run preflight` - 发布前完整检查（清理、安装、格式化、lint、构建、类型检查、测试）

## Package Management

使用 **pnpm** 进行依赖管理：

- 单包结构
- 使用相对路径直接导入
- 所有依赖在根 package.json 管理

## Test Structure

```text
tests/
├── unit/           # 组件级测试
├── integration/    # 多组件工作流测试
├── e2e/            # 完整 CLI 用户旅程测试
├── security/       # 安全测试
├── fixtures/       # 测试固定数据
├── helpers/        # 测试辅助函数
└── mocks/          # 测试模拟对象
```

## Key Entry Points

- **CLI 入口**: [src/blade.tsx](src/blade.tsx) - CLI 应用主入口
- **核心 API**: [src/index.ts](src/index.ts) - 公共 API 导出
- **构建产物**: `dist/blade.js` - 构建后的可执行文件
- **UI 根组件**: [src/ui/App.tsx](src/ui/App.tsx) - Ink UI 主组件
- **CLI 配置**: [src/cli/config.ts](src/cli/config.ts) - yargs CLI 配置
- **命令处理**: [src/commands/](src/commands/) - 各命令处理器

## Environment Variables

- `BLADE_API_KEY` / `QWEN_API_KEY` - API 密钥（千问等）
- `VOLCENGINE_API_KEY` - 火山引擎 API 密钥
- `BLADE_BASE_URL` - API 基础 URL
- `BLADE_MODEL` - 默认模型名称
- `BLADE_DEBUG` - 调试模式开关（启用详细日志）
- `BLADE_VERSION` - 构建系统自动设置的版本号

## Development Workflow

1. **启动开发模式**: `npm run dev`
2. **修改代码**:
   - CLI 入口: [src/blade.tsx](src/blade.tsx)
   - UI 组件: [src/ui/](src/ui/)
   - Agent 逻辑: [src/agent/](src/agent/)
   - 工具开发: [src/tools/](src/tools/)
   - 配置管理: [src/config/](src/config/)
   - 服务层: [src/services/](src/services/)
3. **运行测试**: `npm test` 或特定测试套件
4. **代码检查**: `npm run check:fix` 自动修复问题
5. **类型检查**: `npm run type-check` 验证 TypeScript
6. **构建**: `npm run build` 生产构建

## Build System

### Bun Configuration

- **构建工具**: Bun 原生构建（极速构建性能）
- **目标格式**: Node.js ESM
- **代码压缩**: 生产构建启用 minification
- **外部依赖**: React、Ink、CLI 工具库排除在 bundle 外
- **输出**: 单文件可执行程序

### Build Process

```bash
# 构建命令
npm run build

# 等价于：
rm -rf dist && bun build src/blade.tsx \
  --external react-devtools-core \
  --external react \
  --external react-dom \
  --external ink \
  --external ink-* \
  --external yargs \
  --external chalk \
  --external inquirer \
  --minify \
  --outfile dist/blade.js \
  --target=node
```

### Build Output

- `dist/blade.js`: ~1MB (包含所有核心逻辑的可执行文件)

## UI Framework

项目使用 **Ink** 构建 CLI UI（React for CLI）：

- 基于 React 组件模型
- 支持 hooks 和现代 React 特性
- 丰富的 Ink 生态组件：
  - `ink-text-input` - 文本输入
  - `ink-select-input` - 选择列表
  - `ink-spinner` - 加载动画
  - `ink-progress-bar` - 进度条
  - `ink-gradient` / `ink-big-text` - 视觉效果

## Code Style Guidelines

遵循 Biome 配置的代码风格：

- **单引号**: 字符串使用单引号
- **分号**: 语句结尾必须有分号
- **行宽**: 最大 88 字符
- **缩进**: 2 空格
- **TypeScript**: 尽量避免 `any`，测试文件除外
