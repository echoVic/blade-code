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
│   ├── telemetry/      # 遥测和监控
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
  - 通过 `LoopDetectionService` 防止无限循环

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

### 创建新文档指南

#### 1. 确定文档类型

**问自己以下问题：**
- 这个文档是给谁看的？（用户/开发者/贡献者）
- 这个文档的目的是什么？（教程/指南/参考/技术方案）
- 这个文档需要对外公开吗？

**文档归属判断：**

| 文档内容 | 目标目录 | 示例 |
|---------|---------|------|
| 用户安装、配置 | `docs/public/getting-started/` | installation.md, quick-start.md |
| 用户配置指南 | `docs/public/configuration/` | config-system.md, permissions.md |
| 用户使用教程 | `docs/public/guides/` | advanced-usage.md |
| CLI/工具参考 | `docs/public/reference/` | cli-commands.md, tool-list.md |
| 架构设计 | `docs/development/architecture/` | execution-pipeline.md, tool-system.md |
| 实现细节 | `docs/development/implementation/` | logging-system.md, mcp-support.md |
| 技术方案 | `docs/development/planning/` | xxx-plan.md, xxx-proposal.md |
| 测试相关 | `docs/development/testing/` | index.md, coverage.md |
| 贡献规范 | `docs/contributing/` | README.md, pr-creation-guide.md |
| 过时文档 | `docs/archive/` | 历史参考文档 |

#### 2. 文档命名规范

- 使用小写字母和连字符：`config-system.md`（不是 `ConfigSystem.md`）
- 名称要描述性强：`execution-pipeline.md`（不是 `pipeline.md`）
- 技术方案文档加后缀：`feature-name-plan.md` 或 `feature-name-proposal.md`

#### 3. 文档内容规范

**每个文档应包含：**

```markdown
# 标题

> 简短描述：一句话说明这个文档的目的

## 目录（可选，复杂文档需要）

- [章节1](#章节1)
- [章节2](#章节2)

## 正文内容

### 使用代码示例

\`\`\`typescript
// 代码示例要完整且可运行
const example = 'hello';
\`\`\`

### 使用相对链接

引用其他文档时使用相对路径：
- 同目录：[其他文档](other-doc.md)
- 父目录：[上级文档](../parent-doc.md)
- 其他分类：[开发文档](../../development/architecture/tool-system.md)

### 使用表格和图表

让文档易于理解。

## 参考资源（可选）

- 相关文档链接
- 外部资源链接
```

#### 4. 更新文档索引

创建新文档后，必须更新相应的索引：

- **用户文档**: 更新 `docs/public/_sidebar.md` 和 `docs/public/README.md`
- **开发者文档**: 更新 `docs/development/README.md`
- **贡献者文档**: 更新 `docs/contributing/README.md`
- **文档中心**: 如果是重要文档，更新 `docs/index.md`

#### 5. 文档维护原则

- **避免重复**：一个主题只写一份文档，其他地方通过链接引用
- **保持同步**：代码变更时及时更新相关文档
- **及时归档**：过时文档移到 `docs/archive/`，不要直接删除
- **交叉引用**：相关文档之间相互链接，形成文档网络

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
