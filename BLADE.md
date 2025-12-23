# BLADE.md

always respond in Chinese

## 项目概述

**Blade Code** 是一个基于 React + Ink 构建的智能 AI 编程助手 CLI 工具，使用 TypeScript 开发。

- **项目类型**: CLI 工具（TUI 应用）
- **主要语言**: TypeScript
- **运行时**: Node.js >=16.0.0（开发使用 Bun）
- **UI 框架**: React 19 + Ink（终端 UI）
- **状态管理**: Zustand
- **配置管理**: 支持 JSON 配置和环境变量插值
- **测试框架**: Vitest
- **代码质量**: Biome（Lint + Format）

## 核心特性

- 🤖 智能对话，支持上下文理解和多轮对话
- 🛠️ 内置 18+ 工具（文件读写、代码搜索、Shell 执行、Git 操作等）
- 🔗 支持 Model Context Protocol (MCP)，可扩展外部工具
- 💾 会话管理（多会话、继续对话、会话 Fork）
- 🔒 三级权限系统（allow/ask/deny）、工具白名单、操作确认
- 🎨 现代 UI，支持 Markdown 渲染和语法高亮

## 关键命令

### 开发命令
```bash
# 开发模式（热重载）
bun run dev

# 构建项目
bun run build

# 运行构建后的版本
bun run start
```

### 测试命令
```bash
# 运行所有测试
bun run test:all

# 运行单元测试
bun run test:unit

# 运行集成测试
bun run test:integration

# 运行 CLI 测试
bun run test:cli

# 带覆盖率测试
bun run test:coverage

# 监听模式
bun run test:watch

# 调试模式
bun run test:debug
```

### 代码质量
```bash
# Lint
bun run lint

# 自动修复 Lint 问题
bun run lint:fix

# 格式化代码
bun run format

# 检查格式
bun run format:check

# 类型检查
bun run type-check

# 全面检查（类型、Lint、格式、测试）
bun run check:full
```

### 发布命令
```bash
# 发布新版本（自动判断版本号）
bun run release

# 预览发布
bun run release:dry

# 指定版本号
bun run release:major
bun run release:minor
bun run release:patch
```

### 其他命令
```bash
# 清理构建产物
bun run clean

# 预检（清理、安装、格式化、Lint、构建、类型检查、测试）
bun run preflight

# 下载 ripgrep 二进制
bun run vendor:ripgrep

# 安全审计
bun run security:audit
```

## 架构概览

### 核心设计原则

1. **无状态 Agent 设计**: Agent 本身不保存会话状态，所有状态通过 context 参数传入，实例可每次命令创建，用完即弃
2. **工具系统**: 统一的工具注册、执行、验证系统，支持内置工具和 MCP 扩展
3. **权限控制**: 三级权限系统（allow/ask/deny），支持工具白名单和操作确认
4. **会话管理**: 支持多会话、会话恢复、会话 Fork，历史连续性由外部 SessionContext 保证

### 主要模块

```
src/
├── agent/              # Agent 核心（无状态设计）
│   ├── Agent.ts        # Agent 主类
│   ├── ExecutionEngine.ts  # 执行引擎
│   └── types.ts        # 类型定义
├── tools/              # 工具系统
│   ├── builtin/        # 内置工具（file、search、shell、web 等）
│   ├── core/           # 核心工具系统（createTool、ToolInvocation）
│   ├── execution/      # 执行引擎（ExecutionPipeline）
│   ├── registry/       # 注册系统（ToolRegistry、ToolResolver）
│   ├── types/          # 类型定义（Tool、ToolResult、ToolKind）
│   └── validation/     # 验证系统（Zod Schema）
├── mcp/                # MCP 协议支持
│   ├── McpClient.ts    # MCP 客户端
│   ├── McpRegistry.ts  # MCP 注册表
│   └── loadMcpConfig.ts # 配置加载
├── context/            # 上下文管理
│   ├── ContextManager.ts  # 上下文管理器
│   ├── CompactionService.ts  # 上下文压缩服务
│   └── TokenCounter.ts  # Token 计数器
├── config/             # 配置管理
│   ├── ConfigManager.ts  # 配置管理器
│   ├── ConfigService.ts  # 配置服务
│   └── PermissionChecker.ts  # 权限检查器
├── ui/                 # UI 组件（React + Ink）
│   ├── App.tsx         # 主应用
│   └── components/     # UI 组件
├── store/              # 状态管理（Zustand）
│   └── vanilla.js      # Zustand store
├── services/           # 服务
│   ├── ChatServiceInterface.ts  # 聊天服务接口
│   └── GracefulShutdown.ts  # 优雅关闭
├── cli/                # CLI 相关
│   ├── config.ts       # CLI 配置
│   └── middleware.ts   # 中间件
├── commands/           # 命令处理
│   ├── doctor.ts       # doctor 命令
│   ├── install.ts      # install 命令
│   ├── mcp.ts          # mcp 命令
│   ├── print.ts        # print 模式处理
│   └── update.ts       # update 命令
├── prompts/            # 提示词
│   ├── index.ts        # 提示词入口
│   └── processors/     # 处理器（AttachmentCollector）
├── utils/              # 工具函数
│   ├── environment.ts  # 环境检测
│   ├── git.ts          # Git 相关
│   └── pathSecurity.ts  # 路径安全检查
├── hooks/              # React Hooks
├── ide/                # IDE 集成
├── logging/            # 日志系统
└── slash-commands/     # Slash 命令
```

### 工具系统架构

工具系统是 Blade Code 的核心，采用统一的设计：

1. **工具创建**: 使用 `createTool` 工厂函数创建工具，支持 Zod Schema 验证
2. **工具注册**: 通过 `ToolRegistry` 注册工具，支持内置工具和动态加载
3. **工具执行**: 通过 `ExecutionPipeline` 执行工具调用，支持前置/后置处理器
4. **工具验证**: 使用 Zod Schema 进行参数验证，支持错误格式化
5. **工具类型**: 支持多种工具类型（ReadOnly、Write、Dangerous 等）

内置工具分类：
- **file**: 文件操作（read、write、edit、glob 等）
- **search**: 搜索工具（grep、glob 等）
- **shell**: Shell 命令执行
- **web**: 网络工具（fetch 等）
- **task**: 任务管理
- **todo**: Todo 管理
- **plan**: 计划管理
- **notebook**: Notebook 操作
- **system**: 系统工具

### MCP 集成

支持 Model Context Protocol (MCP)，可轻松扩展外部工具：

1. **MCP 客户端**: `McpClient` 负责与 MCP 服务器通信
2. **MCP 注册表**: `McpRegistry` 管理 MCP 工具和服务器
3. **配置加载**: `loadMcpConfig` 从配置文件加载 MCP 配置
4. **健康检查**: `HealthMonitor` 监控 MCP 服务器健康状态

### 会话管理

- **会话存储**: 使用文件系统存储会话数据（`~/.blade/sessions/`）
- **会话恢复**: 支持通过 `--resume <id>` 恢复指定会话
- **会话 Fork**: 支持通过 `--fork-session` 创建会话副本
- **上下文压缩**: 使用 `CompactionService` 压缩长对话历史

### 权限系统

三级权限控制：

1. **allow**: 自动批准所有操作
2. **ask**: 每次操作前询问用户确认
3. **deny**: 拒绝所有操作

支持工具白名单和权限模式（plan、yolo 等）

## 非显而易见的约定和陷阱

### 1. **无状态 Agent 设计**

Agent 本身不保存任何会话状态，所有状态必须通过 `context` 参数传入。这意味着：

- 每次命令都会创建新的 Agent 实例
- 不要在 Agent 内部存储状态
- 历史连续性由外部 `SessionContext` 保证

### 2. **工具结果格式**

工具执行结果必须包含三部分：

```typescript
{
  success: boolean,
  llmContent: string | object,  // 给 LLM 的内容（用于下一步决策）
  displayContent: string,       // 给用户的内容（显示在终端）
  metadata?: object            // 元数据（可选）
}
```

常见错误：只返回 `llmContent` 或 `displayContent` 中的一个，导致 LLM 无法理解结果或用户看不到反馈。

### 3. **Zod Schema 验证**

所有工具参数必须使用 Zod Schema 定义，并添加详细的 `describe`：

```typescript
schema: z.object({
  file_path: z.string().describe('绝对路径，例如 /Users/name/project/file.ts'),
  encoding: z.enum(['utf8', 'base64']).optional().describe('文件编码，默认为 utf8')
})
```

缺少 `describe` 会导致 LLM 无法理解参数含义，生成错误的参数。

### 4. **路径安全**

所有文件操作必须经过路径安全检查：

```typescript
import { validatePathAccess } from '../utils/pathSecurity.js';

// 验证路径是否在允许范围内
const validatedPath = await validatePathAccess(params.file_path, context);
```

禁止直接调用 `fs.readFile` 或 `fs.writeFile` 而不进行路径验证。

### 5. **权限检查**

工具执行前必须检查权限：

```typescript
import { PermissionChecker } from '../config/PermissionChecker.js';

const checker = new PermissionChecker(config.permissions);
const allowed = await checker.checkToolPermission(toolName);

if (!allowed) {
  throw new Error(`工具 ${toolName} 被权限配置禁止`);
}
```

### 6. **Token 管理**

长对话历史会自动压缩，但需要注意：

- 压缩策略基于 Token 数量和消息重要性
- 重要消息（工具调用结果、用户确认）会被保留
- 压缩后的上下文可能丢失部分细节

### 7. **MCP 工具命名冲突**

MCP 工具名称格式为 `{serverName}_{toolName}`，可能与内置工具冲突。注册时使用 `ToolRegistry` 会自动处理冲突，但需要注意：

- 内置工具优先级高于 MCP 工具
- 同名 MCP 工具后注册的会覆盖先注册的

### 8. **React Ink 限制**

Ink 是终端 UI 框架，存在以下限制：

- 不支持所有 CSS 属性
- 某些 Unicode 字符可能显示异常
- 长文本需要手动处理换行
- 组件更新频率过高会导致闪烁

### 9. **配置文件加载顺序**

配置文件加载优先级（从高到低）：

1. 命令行参数（`--config`）
2. 环境变量（`BLADE_CONFIG`）
3. 项目根目录（`./.blade/config.json`）
4. 用户主目录（`~/.blade/config.json`）
5. 默认配置

### 10. **Session ID 生成**

Session ID 使用 `nanoid` 生成，长度为 21 个字符。自定义 Session ID 必须满足：

- 只包含字母、数字、下划线、连字符
- 长度不超过 50 个字符
- 不能包含特殊字符或空格

### 11. **工具执行超时**

工具执行默认超时时间为 30 秒，可通过 `executionTimeout` 配置修改。长时间运行的工具需要：

- 定期发送心跳（`onProgress` 回调）
- 处理取消信号（`signal` 参数）
- 提供进度信息（`displayContent` 更新）

### 12. **日志级别**

日志系统使用 `pino`，支持以下级别：

- `fatal`: 致命错误
- `error`: 错误
- `warn`: 警告
- `info`: 信息
- `debug`: 调试
- `trace`: 追踪

生产环境默认级别为 `info`，开发环境为 `debug`。使用 `Logger.setGlobalDebug()` 可以动态调整。

### 13. **跨平台兼容性**

代码需要支持 macOS、Linux、Windows：

- 路径处理使用 `path` 模块，避免硬编码 `/` 或 `\`
- Shell 命令使用 `execa` 或 `cross-spawn`
- 文件系统操作注意大小写敏感性
- 换行符使用 `os.EOL`

### 14. **测试数据清理**

测试用例中创建的文件、目录、会话必须在测试结束后清理：

```typescript
afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  await SessionManager.cleanupTestSessions();
});
```

### 15. **Git Hook**

项目使用 Husky 管理 Git Hook，提交前会自动运行：

- Biome 检查（Lint + Format）
- 类型检查
- 单元测试

提交前确保所有检查通过，否则无法提交。

## 关键文件位置

### 配置文件
- `~/.blade/config.json`: 用户配置
- `~/.blade/sessions/`: 会话存储
- `~/.blade/logs/`: 日志文件
- `./.blade/config.json`: 项目配置（优先级高于用户配置）

### 核心代码
- `src/blade.tsx`: 入口文件
- `src/agent/Agent.ts`: Agent 核心
- `src/tools/builtin/`: 内置工具
- `src/tools/core/createTool.ts`: 工具创建工厂
- `src/config/ConfigManager.ts`: 配置管理
- `src/context/ContextManager.ts`: 上下文管理
- `src/mcp/McpRegistry.ts`: MCP 注册表
- `src/ui/App.tsx`: UI 主组件

### 测试文件
- `tests/unit/`: 单元测试
- `tests/integration/`: 集成测试
- `tests/cli/`: CLI 测试
- `vitest.config.ts`: Vitest 配置

### 文档
- `README.md`: 项目说明
- `src/tools/README.md`: 工具系统文档
- `docs/`: 详细文档

### 脚本
- `scripts/build.ts`: 构建脚本
- `scripts/test.js`: 测试运行器
- `scripts/release.js`: 发布脚本
- `scripts/download-ripgrep.js`: 下载 ripgrep

### 重要常量
- `src/ui/constants.ts`: UI 常量
- `src/config/defaults.ts`: 默认配置
- `src/tools/types/ToolTypes.ts`: 工具类型定义

### 日志分类
- `src/logging/Logger.ts`: 日志系统
- `LogCategory`: 日志分类（AGENT、TOOL、MCP、UI 等）

### 错误处理
- `src/tools/types/ToolTypes.ts`: 工具错误类型
- `ToolErrorType`: EXECUTION_ERROR、VALIDATION_ERROR、PERMISSION_DENIED 等

### 权限相关
- `src/config/PermissionChecker.ts`: 权限检查
- `src/config/types.ts`: 权限配置类型
- `PermissionMode`: allow、ask、deny

### MCP 配置
- `~/.blade/mcp.json`: MCP 配置文件
- `src/mcp/loadMcpConfig.ts`: 配置加载
- `src/mcp/McpClient.ts`: MCP 客户端

### 提示词
- `src/prompts/`: 提示词模板
- `src/prompts/processors/`: 提示词处理器

### Slash 命令
- `src/slash-commands/`: Slash 命令实现
- 支持 `/init`、`/help`、`/clear`、`/compact`、`/context`、`/agents`、`/permissions`、`/mcp`、`/resume`、`/theme`、`/model`