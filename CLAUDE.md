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
│   ├── config/         # 统一配置管理（双文件系统）
│   │   ├── ConfigManager.ts      # 配置管理器
│   │   ├── PermissionChecker.ts  # 权限检查器
│   │   ├── types.ts              # 配置类型定义
│   │   └── defaults.ts           # 默认配置
│   ├── context/        # 上下文管理和压缩
│   ├── error/          # 错误处理和恢复
│   ├── ide/            # IDE集成和扩展
│   ├── logging/        # 日志系统
│   ├── mcp/            # MCP协议实现
│   ├── prompts/        # 提示模板管理
│   ├── security/       # 安全管理
│   ├── services/       # 共享服务层
│   ├── slash-commands/ # 内置斜杠命令
│   ├── spec/           # Spec-Driven Development 模式
│   │   ├── SpecService.ts        # 无状态文件操作服务
│   │   ├── SpecManager.ts        # 运行时状态管理器
│   │   ├── SpecFileManager.ts    # 目录和文件操作
│   │   └── types.ts              # 类型定义
│   ├── telemetry/      # 遥测和监控（历史目录，当前实现中已不再使用）
│   ├── tools/          # 工具系统
│   │   ├── builtin/    # 内置工具（Read/Write/Bash等）
│   │   ├── execution/  # 执行管道
│   │   │   ├── ExecutionPipeline.ts  # 6阶段管道
│   │   │   └── PipelineStages.ts     # 各阶段实现
│   │   ├── registry/   # 工具注册中心
│   │   ├── types/      # 工具类型定义
│   │   └── validation/ # 参数验证
│   ├── ui/             # UI组件和界面（基于Ink）
│   │   ├── components/ # UI组件
│   │   │   ├── BladeInterface.tsx    # 主界面
│   │   │   ├── MessageRenderer.tsx   # Markdown渲染器（主入口）
│   │   │   ├── InlineRenderer.tsx    # 内联格式渲染
│   │   │   ├── CodeHighlighter.tsx   # 代码语法高亮
│   │   │   ├── TableRenderer.tsx     # 表格渲染
│   │   │   ├── ListItem.tsx          # 列表项渲染
│   │   │   └── ConfirmationPrompt.tsx # 确认提示
│   │   ├── hooks/      # React Hooks
│   │   │   ├── useCommandHandler.ts  # 命令处理
│   │   │   └── useConfirmation.ts    # 确认管理
│   │   └── utils/      # UI工具函数
│   │       └── markdown.ts           # Markdown工具函数
│   ├── utils/          # 通用工具函数
│   ├── index.ts        # 公共API导出
│   └── blade.tsx       # CLI应用入口
├── tests/              # 测试文件（独立）
│   ├── unit/           # 组件级测试
│   ├── integration/    # 多组件工作流测试
│   ├── e2e/            # 端到端CLI测试
│   └── security/       # 安全测试
├── docs/               # 项目文档（按受众分类）
│   ├── index.md        # 文档中心导航
│   ├── public/         # 用户文档（Docsify站点）
│   │   ├── getting-started/    # 快速开始
│   │   ├── configuration/      # 配置指南
│   │   ├── guides/             # 使用指南
│   │   └── reference/          # 参考文档
│   ├── development/    # 开发者文档（内部技术）
│   │   ├── architecture/       # 架构设计
│   │   ├── implementation/     # 实现细节
│   │   ├── planning/           # 技术方案
│   │   ├── testing/            # 测试文档
│   │   └── api-reference.md    # API参考
│   ├── contributing/   # 贡献者文档（开源贡献）
│   │   ├── README.md           # 贡献指南
│   │   ├── pr-creation-guide.md
│   │   ├── release-process.md
│   │   └── security-policy.md
│   └── archive/        # 归档文档（历史参考）
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
  - **无状态设计**: Agent 不保存 sessionId 和消息历史
  - 静态工厂方法 `Agent.create()` 用于创建和初始化实例
  - 每次命令可创建新 Agent 实例（用完即弃）
  - 通过 `ExecutionEngine` 处理工具执行流程
  - **安全保障**: 通过 `maxTurns` + 硬性轮次上限 `SAFETY_LIMIT = 100` 控制循环（已移除 LoopDetectionService，避免与系统提示冲突）

- **SessionContext** ([src/ui/contexts/SessionContext.tsx](src/ui/contexts/SessionContext.tsx)): 会话状态管理
  - 维护全局唯一 `sessionId`
  - 保存完整消息历史
  - 通过 React Context 跨组件共享
  - Agent 通过 context 参数获取历史消息

- **架构模式**: 无状态 Agent + 外部 Session
  - ✅ 状态隔离: Agent 无状态，Session 有状态
  - ✅ 对话连续: 通过传递历史消息保证上下文
  - ✅ 内存高效: Agent 用完即释放
  - ✅ 并发安全: 多个 Agent 可并发执行

- **ToolRegistry** ([src/tools/registry/ToolRegistry.ts](src/tools/registry/ToolRegistry.ts)): 中心化工具注册/执行系统，提供验证和安全控制
- **ChatService** ([src/services/ChatService.ts](src/services/ChatService.ts)): 统一LLM接口，支持多提供商（基于OpenAI客户端）
  - 支持流式和非流式响应
  - 内置重试机制和错误处理
  - 工具调用集成

### Key Services
- **ConfigManager** ([src/config/ConfigManager.ts](src/config/ConfigManager.ts)): 双文件配置管理系统
  - config.json: 基础配置（API、模型、UI）
  - settings.json: 行为配置（权限、Hooks、环境变量）
  - 配置优先级：环境变量 > 本地配置 > 项目配置 > 用户配置 > 默认值
- **PermissionChecker** ([src/config/PermissionChecker.ts](src/config/PermissionChecker.ts)): 三级权限控制系统
  - 支持 allow/ask/deny 规则
  - 支持精确匹配、通配符、Glob 模式
  - 集成在执行管道的第 3 阶段
- **ExecutionPipeline** ([src/tools/execution/ExecutionPipeline.ts](src/tools/execution/ExecutionPipeline.ts)): 5 阶段执行管道
  - Discovery → Permission (Zod验证+默认值) → Confirmation → Execution → Formatting
  - 事件驱动架构，支持监听各阶段事件
  - 自动记录执行历史
- **PromptBuilder** ([src/prompts/](src/prompts/)): 提示模板管理和构建
- **ContextManager** ([src/context/ContextManager.ts](src/context/ContextManager.ts)): 上下文管理系统
  - **JSONL 格式**: 追加式存储，每行一个 JSON 对象
  - **项目隔离**: 存储在 `~/.blade/projects/{escaped-path}/` 按项目分离
  - **会话 ID**: 使用 nanoid 生成，21 字符 URL 友好
  - **路径转义**: `/Users/foo/project` → `-Users-foo-project`
  - 支持消息追溯（parentUuid）、Git 分支记录、Token 统计

### Markdown 渲染系统

Blade 提供完整的 Markdown 渲染支持，包含以下组件：

- **MessageRenderer** ([src/ui/components/MessageRenderer.tsx](src/ui/components/MessageRenderer.tsx)): 主渲染器，解析 Markdown 为结构化块
  - 支持代码块、表格、标题（H1-H4）、列表（有序/无序）、水平线
  - 状态机解析嵌套结构（代码块、表格）
  - 角色区分渲染（用户/助手/系统不同颜色前缀）

- **InlineRenderer** ([src/ui/components/InlineRenderer.tsx](src/ui/components/InlineRenderer.tsx)): 内联格式渲染
  - 支持：`**粗体**`、`*斜体*`、`~~删除线~~`、`` `代码` ``、`[链接](URL)`、自动识别 URL
  - 统一正则表达式一次性匹配所有格式
  - 边界检测避免误判文件路径（如 `file_name.txt`）

- **CodeHighlighter** ([src/ui/components/CodeHighlighter.tsx](src/ui/components/CodeHighlighter.tsx)): 代码语法高亮
  - 使用 `lowlight`（基于 highlight.js）支持 140+ 语言
  - **性能优化**：智能截断长代码块（仅高亮可见行，提升 90% 性能）
  - 行号显示、语言标签、圆角边框

- **TableRenderer** ([src/ui/components/TableRenderer.tsx](src/ui/components/TableRenderer.tsx)): 表格渲染
  - 使用 `getPlainTextLength()` 计算真实显示宽度（排除 Markdown 标记）
  - 自动缩放以适应终端宽度
  - 二分搜索智能截断（保留 Markdown 格式完整性）
  - 美观的 Unicode 边框

- **ListItem** ([src/ui/components/ListItem.tsx](src/ui/components/ListItem.tsx)): 列表项渲染
  - 支持有序列表（`1. 项目`）和无序列表（`- 项目`）
  - 支持嵌套列表（通过前导空格计算缩进）
  - 列表项内容支持内联 Markdown

- **markdown.ts** ([src/ui/utils/markdown.ts](src/ui/utils/markdown.ts)): Markdown 工具函数
  - `getPlainTextLength()`: 计算去除标记后的真实显示宽度（使用 `string-width`）
  - `truncateText()`: 二分搜索智能截断（保留格式）
  - `hasMarkdownFormat()`: 快速检测是否包含 Markdown 标记

**主题集成**：
- 所有颜色从 `themeManager.getTheme()` 获取
- 支持主题实时切换
- H1/H2 使用 `primary` 颜色，内联代码使用 `accent` 颜色，链接使用 `info` 颜色

**性能优化**：
- 纯文本快速路径（跳过解析）
- 长代码块仅高亮可见行（1000 行从 150ms 降至 15ms）
- 表格自动缩放和智能截断

**文档**：
- 用户文档：[docs/public/guides/markdown-support.md](docs/public/guides/markdown-support.md)
- 开发者文档：[docs/development/implementation/markdown-renderer.md](docs/development/implementation/markdown-renderer.md)

## State Management Architecture

### Zustand Store 设计

Blade 使用 **Zustand** 作为全局状态管理库，采用 **单一数据源 (SSOT)** 架构：

**核心原则**：
- **Store 是唯一读取源** - 所有组件和服务从 Store 读取状态
- **vanilla.ts actions 是唯一写入入口** - 自动同步内存 + 持久化
- **ConfigManager 仅用于 Bootstrap** - 初始化时加载配置文件
- **ConfigService 负责持久化** - 运行时写入配置文件

**架构图**：
```
Bootstrap (启动时):
  ConfigManager.initialize() → 返回 BladeConfig → Store.setConfig()

Runtime (运行时):
  UI/Agent → vanilla.ts actions → Store (内存SSOT)
                ↓
           ConfigService (持久化到 config.json/settings.json)
```

### 状态管理最佳实践

**✅ 推荐：从 Store 读取**
```typescript
import { getConfig, getCurrentModel } from '../store/vanilla.js';

const config = getConfig();          // 读取完整配置
const model = getCurrentModel();     // 读取当前模型
```

**✅ 推荐：通过 actions 写入**
```typescript
import { configActions } from '../store/vanilla.js';

// 自动同步内存 + 持久化
await configActions().addModel({...});
await configActions().setPermissionMode('yolo');
```

**❌ 避免：直接调用 ConfigManager**
```typescript
// ❌ 错误：绕过 Store，导致数据不一致
const configManager = ConfigManager.getInstance();
await configManager.addModel({...});  // Store 未更新！
```

**React 组件订阅**：
```typescript
// ✅ 使用选择器（精准订阅）
import { useCurrentModel, usePermissionMode } from '../store/selectors/index.js';

const model = useCurrentModel();
const mode = usePermissionMode();

// ✅ 组合选择器使用 useShallow 优化
import { useShallow } from 'zustand/react/shallow';

const { field1, field2 } = useBladeStore(
  useShallow((state) => ({
    field1: state.slice.field1,
    field2: state.slice.field2,
  }))
);
```

### Store 初始化规则

**⚠️ 关键规则**：任何调用 `configActions()` 或读取 `getConfig()` 的代码前，必须确保 Store 已初始化。

**统一防御点（推荐）**：
```typescript
import { ensureStoreInitialized } from '../store/vanilla.js';

// 在执行任何依赖 Store 的逻辑前
await ensureStoreInitialized();
```

**`ensureStoreInitialized()` 特性**：
- ✅ **幂等**：已初始化直接返回（性能无负担）
- ✅ **并发安全**：同一时刻只初始化一次（共享 Promise）
- ✅ **失败重试**：初始化失败后，下次调用会重新尝试
- ✅ **明确报错**：初始化失败抛出详细错误信息

**已添加防御的路径**：
| 路径 | 防御点 | 说明 |
|------|--------|------|
| CLI 命令 | `middleware.ts` | 初始化失败会退出并报错 |
| Slash Commands | `useCommandHandler.ts` | 执行前统一调用 `ensureStoreInitialized()` |
| Agent 创建 | `Agent.create()` | 内置防御性检查 |
| Config Actions | 各方法内部 | 检查 `if (!config) throw` |

**⚠️ 竞态风险**：
- UI 初始化过程中用户立即输入命令
- 多个 slash command 并发执行
- 非 UI 场景（测试/脚本/print mode）复用

**✅ 推荐模式**：
```typescript
// Slash command 执行前
if (isSlashCommand(command)) {
  await ensureStoreInitialized(); // 统一防御点
  const result = await executeSlashCommand(command, context);
}

// CLI 子命令执行前
export const myCommand: CommandModule = {
  handler: async (argv) => {
    await ensureStoreInitialized(); // 防御性检查
    const config = getConfig();
    // ... 使用 config
  }
};
```

**❌ 避免模式**：
```typescript
// ❌ 错误：假设已初始化
const config = getConfig();
if (!config) {
  // 太迟了，某些路径可能已经踩坑
}

// ❌ 错误：静默吞掉初始化失败
try {
  await ensureStoreInitialized();
} catch (error) {
  console.warn('初始化失败，继续执行'); // 危险！
}
```

### Store 初始化机制

三层初始化防护：

1. **UI 路径**：`App.tsx` → useEffect 初始化 Store
2. **CLI 路径**：`middleware.ts` → loadConfiguration 初始化 Store
3. **防御路径**：`Agent.create()` → ensureStoreInitialized() 兜底

详见：[Store 与 Config 架构统一文档](docs/development/implementation/store-config-unification.md)

## Slash Commands

Blade 提供内置的斜杠命令系统，用于执行特定的系统操作。所有 slash 命令实现位于 [src/slash-commands/](src/slash-commands/)。

### 核心命令

- **/init** ([src/slash-commands/init.ts](src/slash-commands/init.ts)): 分析项目并生成 BLADE.md 配置文件
  - **工作原理**: 使用 `Agent.create()` + `agent.chat()` 动态分析项目
  - **新文件生成**: 读取 package.json → 探索项目结构 → 分析架构 → 生成 BLADE.md
  - **已有文件分析**: 读取现有 BLADE.md → 检查 package.json 变化 → 探索代码库 → 提供改进建议
  - **重要**: 使用 `agent.chat()` 而非 `chatWithSystem()`，以启用工具调用（Read/Glob/Grep）

- **/help** ([src/slash-commands/builtinCommands.ts](src/slash-commands/builtinCommands.ts)): 显示所有可用命令
- **/clear**: 清除对话历史和屏幕内容
- **/agents** ([src/slash-commands/agents.ts](src/slash-commands/agents.ts)): 管理 subagent 配置（创建、编辑、删除）
- **/mcp**: 显示 MCP 服务器状态和可用工具
- **/resume**: 恢复历史会话
- **/compact**: 手动压缩上下文，生成总结并节省 token
- **/permissions**: 管理本地权限规则
- **/version**: 显示版本信息
- **/config**: 打开配置面板

### 命令架构

**自包含设计**：
- ✅ Slash 命令在其 handler 内部直接执行所有逻辑
- ✅ 需要 Agent 时，直接调用 `Agent.create()` 创建实例
- ✅ 不依赖 UI Hook 的特殊处理（移除了 `trigger_analysis` 模式）
- ✅ 简化了代码流程，降低耦合

**自动补全系统** ([src/slash-commands/index.ts](src/slash-commands/index.ts)):
- **模糊匹配**：支持命令名、别名、描述的模糊搜索
- **智能过滤**：
  - 前缀匹配（≥80 分）优先，过滤掉低分建议
  - 描述匹配权重降低（0.3），避免干扰
  - 输入自动 trim，处理 `/init ` 带空格的情况
- **评分系统**：
  - 完全匹配：100 分
  - 前缀匹配：80 分
  - 包含匹配：60 分
  - 模糊匹配：40 分

**命令注册** ([src/slash-commands/index.ts](src/slash-commands/index.ts)):
```typescript
const slashCommands: SlashCommandRegistry = {
  ...builtinCommands,
  init: initCommand,
  theme: themeCommand,
  permissions: permissionsCommand,
  model: modelCommand,
};
```

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
- **CLI 测试**: `npm run test:cli` - 运行命令行行为测试
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

### 焦点管理系统 (Focus Management)

Blade 使用 Ink 官方的 **useFocus** 和 **useFocusManager** hooks 实现两层焦点管理架构，确保多个输入组件之间不会冲突。

#### 架构设计：两层焦点管理

**第一层：应用级焦点管理（BladeInterface）**

在 [BladeInterface.tsx](src/ui/components/BladeInterface.tsx:125-132) 中，使用 `useFocusManager` 管理主界面和设置向导之间的焦点切换：

```typescript
const { focus } = useFocusManager();

useEffect(() => {
  if (showSetupWizard) {
    focus('setup-wizard');  // 显示设置向导时，焦点转移到向导
  } else {
    focus('main-input');    // 主界面时，焦点在主输入框
  }
}, [showSetupWizard, focus]);
```

**第二层：组件级焦点管理（SetupWizard）**

在 [SetupWizard.tsx](src/ui/components/SetupWizard.tsx:290-303) 中，使用 `useFocusManager` 管理步骤之间的焦点：

```typescript
const { isFocused } = useFocus({ id: 'setup-wizard' });
const { focus } = useFocusManager();

useEffect(() => {
  if (!isFocused) return; // 只在向导有焦点时才管理内部步骤

  if (currentStep === 'provider') {
    focus('provider-step');
  } else if (currentStep === 'confirm') {
    focus('confirm-step');
  }
  // TextInput 步骤不调用 focus()，让 TextInput 自然获得键盘控制
}, [currentStep, isFocused, focus]);
```

#### 核心原则

1. **显式优于隐式** - 使用 `focus(id)` 显式控制焦点，而非依赖 `autoFocus`
2. **中心化管理** - 焦点切换逻辑集中在两个层级
3. **层级隔离** - 子组件焦点只在父组件有焦点时才生效
4. **特殊处理 TextInput** - TextInput 步骤不使用焦点，让其独占键盘输入
5. **Agent 执行时允许输入** - 新输入进入队列，而非禁用焦点

#### 焦点 ID 映射表

| 组件 | 焦点 ID | 说明 |
|-----|---------|------|
| 主输入框 | `main-input` | 默认焦点 |
| 设置向导 | `setup-wizard` | 向导容器 |
| Provider 选择 | `provider-step` | SelectInput 步骤 |
| 确认步骤 | `confirm-step` | Y/N 输入步骤 |
| TextInput 步骤 | 无 | 不使用焦点，独占键盘 |

#### 最佳实践

**✅ 推荐：**
1. 所有可聚焦组件使用显式 `id`：`useFocus({ id: 'unique-id' })`
2. 使用 `useFocusManager.focus(id)` 显式控制焦点转移
3. 所有 `useInput` 必须添加 `{ isActive: isFocused }`
4. TextInput 组件不使用 `useFocus`（支持粘贴功能）

**❌ 避免：**
1. ❌ 不要依赖 `autoFocus`，使用显式 `focus(id)`
2. ❌ 不要在 TextInput 步骤调用 `focus()`
3. ❌ 不要使用 `useFocusManager.disableFocus()` 阻止输入

## Code Style Guidelines

遵循 Biome 配置的代码风格：

- **单引号**: 字符串使用单引号
- **分号**: 语句结尾必须有分号
- **行宽**: 最大 88 字符
- **缩进**: 2 空格
- **TypeScript**: 尽量避免 `any`，测试文件除外

### 导入规范

- **禁止动态导入**: 不要使用 `await import()` 动态导入模块，应使用顶部静态 `import` 语句
  ```typescript
  // ❌ 错误
  const showStatus = async () => {
    const { HookManager } = await import('../../hooks/HookManager.js');
    // ...
  };

  // ✅ 正确
  import { HookManager } from '../../hooks/HookManager.js';
  const showStatus = () => {
    const hookManager = HookManager.getInstance();
    // ...
  };
  ```
- **例外**: 仅在确实需要代码分割或条件加载时才使用动态导入（如按需加载大型依赖）

## Documentation Guidelines

### 文档结构

项目文档按受众分为三大类：

1. **用户文档** (`docs/public/`) - 面向最终用户
   - 安装、配置、使用指南
   - 通过 Docsify 构建静态站点
   - 适合 GitHub Pages 部署

2. **开发者文档** (`docs/development/`) - 面向项目开发者
   - 架构设计、实现细节
   - 技术方案、测试文档
   - 不对外公开

3. **贡献者文档** (`docs/contributing/`) - 面向开源贡献者
   - 贡献指南、PR 规范
   - 发布流程、安全策略
   - 适合 GitHub 仓库展示

### 文档分类

| 文档类型 | 目标目录 | 用途 |
|---------|---------|------|
| 用户文档 | `docs/public/` | 安装、配置、使用指南（Docsify 站点） |
| 开发者文档 | `docs/development/` | 架构、实现细节、技术方案 |
| 贡献者文档 | `docs/contributing/` | 贡献指南、PR 规范、发布流程 |
| 归档文档 | `docs/archive/` | 过时但保留的历史文档 |

创建新文档后更新相应的索引文件（`_sidebar.md` 或 `README.md`）

### Docsify 用户文档站点

`docs/public/` 目录配置了 Docsify 静态站点：

- **本地预览**:
  ```bash
  npm install -g docsify-cli
  docsify serve docs/public
  # 访问 http://localhost:3000
  ```

- **配置文件**:
  - `index.html` - Docsify 配置
  - `_sidebar.md` - 侧边栏导航
  - `_coverpage.md` - 封面页
  - `.nojekyll` - 禁用 Jekyll

- **添加新页面**:
  1. 在 `docs/public/` 对应目录创建 `.md` 文件
  2. 在 `_sidebar.md` 中添加导航链接
  3. 本地预览验证效果

### 文档编写最佳实践

1. **从用户角度出发**：用户文档应该回答"如何做"而非"这是什么"
2. **提供完整示例**：代码示例要能直接运行，不需要额外修改
3. **循序渐进**：从简单到复杂，从基础到高级
4. **使用视觉辅助**：表格、流程图、代码高亮让文档更易读
5. **保持简洁**：一个文档只讲一个主题，不要贪多
6. **定期审查**：每个月检查文档是否还与代码实现一致

## 文本编辑工具设计


### 核心工具


1. **Read** - 读取文件
   - 支持 offset/limit 参数（大文件分页）
   - 默认推荐读取整个文件
   - cat -n 格式（行号从 1 开始）
   - 支持图片、PDF、Jupyter notebooks

2. **Edit** - 字符串替换
   - **强制唯一性**：多重匹配时直接失败（LLM 会自动重试）
   - **Read-Before-Write**：编辑前必须先 Read，否则失败
   - 支持 `replace_all` 参数批量替换
   - 智能引号标准化（支持富文本复制）

3. **Write** - 写入/覆盖文件
   - **Read-Before-Write**：覆盖文件前必须先 Read
   - 支持 utf8、base64、binary 编码
   - 自动创建父目录
   - 自动创建快照（可回滚）

4. **UndoEdit** - 回滚编辑（Blade 扩展）
   - 按 message_id 回滚文件
   - 查看历史版本
   - 集中式快照管理（`~/.blade/file-history/`）

**移除的工具**：

- ❌ **MultiEdit** - 批量编辑（不必要，LLM 可自行批量调用 Edit）

### 关键行为对齐

| 场景 | Claude Code 官方 | Blade 实现 | 状态 |
|-----|-----------------|-----------|------|
| 多重匹配 | 直接失败 | 直接失败 | ✅ 对齐 |
| Read-Before-Edit | 强制失败 | 强制失败 | ✅ 对齐 |
| Read-Before-Write | 强制失败 | 强制失败 | ✅ 对齐 |
| Prompt 描述 | 官方英文 | 官方英文 | ✅ 对齐 |
| 工具数量 | 3 个 | 4 个（+UndoEdit） | ✅ 扩展 |

### 设计理念

1. **简单工具组合 > 复杂单一工具**
   - 保持 Read/Edit/Write 独立
   - LLM 可自由组合批量调用
   - 不引入 MultiEdit 或 TextEditor 统一工具

2. **强制最佳实践**
   - 编辑前必须先读取（防止误操作）
   - 多重匹配时强制提供更多上下文（防止误替换）
   - 自动创建快照（支持回滚）

3. **Prompt 一致性**
   - 降低 LLM 理解成本
   - 与官方文档行为一致

### 技术实现

**安全验证**：
- `FileAccessTracker` - 跟踪已读文件
- `FileLockManager` - 防止并发编辑冲突
- `SnapshotManager` - 集中式快照管理

**详细文档**：
- 实现细节：[text-editor-optimization.md](docs/development/implementation/text-editor-optimization.md)
- 用户指南：待补充

## Spec Mode (规格驱动开发)

Spec Mode 是 Blade 的高级功能，提供结构化的开发工作流，适用于复杂功能的实现。

### 核心理念

Spec-Driven Development (SDD) 遵循 **先规划后编码** 的理念：
- 在编写代码前，先定义清晰的规格说明
- 通过结构化文档作为项目的单一信息源
- 遵循 `Requirements → Design → Tasks → Implementation` 的流程

### 架构设计

```
src/spec/
├── SpecService.ts        # 无状态文件操作服务（SSOT 写入）
├── SpecManager.ts        # 运行时状态管理器
├── SpecFileManager.ts    # 目录和文件操作
├── types.ts              # 类型定义（阶段、任务、元数据）
└── templates/            # 文档模板

src/store/slices/
└── specSlice.ts          # Zustand Store 切片（SSOT）

src/tools/builtin/spec/
├── EnterSpecModeTool.ts      # 进入 Spec 模式
├── ExitSpecModeTool.ts       # 退出/归档
├── GetSpecContextTool.ts     # 获取当前上下文
├── TransitionSpecPhaseTool.ts # 阶段转换
├── AddTaskTool.ts            # 添加任务
├── UpdateTaskStatusTool.ts   # 更新任务状态
├── UpdateSpecTool.ts         # 更新文档
└── ValidateSpecTool.ts       # 验证完整性

src/prompts/
└── spec.ts               # Spec 模式系统提示词
```

### 工作流阶段

```
┌───────┐    ┌─────────────┐    ┌────────┐    ┌───────┐    ┌──────────────┐    ┌──────┐
│ init  │ → │ requirements│ → │ design │ → │ tasks │ → │implementation│ → │ done │
│提案创建│    │  需求定义    │    │架构设计 │    │任务分解│    │    实现中     │    │已完成│
└───────┘    └─────────────┘    └────────┘    └───────┘    └──────────────┘    └──────┘
```

**阶段转换规则**（`PHASE_TRANSITIONS`）：
- `init` → `requirements`
- `requirements` → `design` | `tasks`（可跳过设计）
- `design` → `tasks`
- `tasks` → `implementation`
- `implementation` → `done` | `tasks`（可回退添加任务）
- `done` → 终态

### 目录结构

Spec Mode 在项目根目录创建以下结构：

```
.blade/
├── specs/              # 权威规格（单一信息源）
│   └── [domain]/
│       └── spec.md
├── changes/            # 活跃的变更提案
│   └── <feature>/
│       ├── proposal.md    # 提案描述（为什么做）
│       ├── spec.md        # 规格文件（做什么）
│       ├── requirements.md # 需求文档（EARS 格式）
│       ├── design.md      # 设计文档（怎么做）
│       ├── tasks.md       # 任务分解
│       └── .meta.json     # 元数据（状态、进度等）
├── archive/            # 已完成的变更
└── steering/           # 全局治理文档
    ├── constitution.md # 项目治理原则
    ├── product.md      # 产品愿景
    ├── tech.md         # 技术栈约束
    └── structure.md    # 代码组织模式
```

### 进入方式

**主要方式：Shift+Tab 切换**
```
DEFAULT → AUTO_EDIT → PLAN → SPEC → DEFAULT
```

状态栏显示：`📋 spec: tasks 3/5 (shift+tab to cycle)`

进入 Spec 模式后，AI 会主动引导用户完成工作流，用户只需通过自然语言对话即可。

### 对话驱动工作流

进入 Spec 模式后，用户**无需记忆任何命令**：

1. **无活跃 Spec 时**：AI 询问"你想实现什么功能？"
2. **有活跃 Spec 时**：AI 显示当前进度并建议下一步
3. **阶段推进**：用户说"好"、"继续"等即可推进

**对话示例**：
```
用户: 我想实现用户认证
AI: [调用 EnterSpecMode] 已创建 Spec: user-auth。现在开始定义需求...

用户: 需求写好了
AI: [调用 TransitionSpecPhase] 进入设计阶段。让我创建架构图...

用户: 开始实现
AI: [获取下一个任务] 开始任务 1: 创建 User 模型...
```

### AI 工具（自动调用）

Spec 模式下 AI 自动使用这些工具完成工作流：

| 工具 | 用途 |
|-----|------|
| `EnterSpecMode` | 创建新 Spec |
| `UpdateSpec` | 更新文档（proposal/requirements/design/tasks） |
| `GetSpecContext` | 获取当前上下文和进度 |
| `TransitionSpecPhase` | 阶段转换 |
| `AddTask` | 添加任务 |
| `UpdateTaskStatus` | 更新任务状态 |
| `ValidateSpec` | 验证完整性 |
| `ExitSpecMode` | 退出/归档 |

### Store 集成

Spec 状态通过 `specSlice` 管理，遵循 SSOT 原则：

**状态读取**：
```typescript
import { getCurrentSpec } from '../store/vanilla.js';
import { useCurrentSpec, useSpecProgress } from '../store/selectors/index.js';

// Vanilla
const spec = getCurrentSpec();

// React Hook
const spec = useCurrentSpec();
const { phase, completed, total } = useSpecProgress();
```

**状态写入**：
```typescript
import { specActions } from '../store/vanilla.js';

await specActions().createSpec('my-feature', 'Description');
await specActions().transitionPhase('design');
await specActions().addTask('Create API', 'Implement REST endpoints');
await specActions().updateTaskStatus('task-id', 'completed');
```

### 系统提示词集成

Spec 模式使用专用提示词（`src/prompts/spec.ts`）：

```typescript
import { buildSystemPrompt } from '../prompts/builder.js';

const { prompt } = await buildSystemPrompt({
  mode: PermissionMode.SPEC,
  currentSpec: getCurrentSpec(),
  steeringContext: await specActions().getSteeringContextString(),
});
```

**提示词特点**：
- **对话驱动**：用户无需记忆命令，AI 主动引导
- **阶段提示**：根据当前阶段提供具体指导
- **工具映射**：直接使用 Spec 工具完成工作流

### 与 Plan Mode 的区别

| 特性 | Plan Mode | Spec Mode |
|------|-----------|-----------|
| 复杂度 | 简单任务 | 复杂功能 |
| 文档 | 单个计划文件 | 多个结构化文档 |
| 阶段 | 单阶段 | 六阶段工作流 |
| 持久化 | 临时 | 永久归档 |
| 任务追踪 | 无 | 依赖管理、进度显示 |
| 状态栏 | `‖ plan mode on` | `📋 spec: tasks 3/5` |

### 详细文档

- 用户指南：[docs/public/guides/spec-mode.md](docs/public/guides/spec-mode.md)
