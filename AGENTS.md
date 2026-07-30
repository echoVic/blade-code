# AGENTS.md

本文件为 AI Agent 提供项目指导。

## WHY: 目的和目标

**Blade Code** 是一个现代化的 AI 编程助手 CLI 工具，旨在通过自然语言交互提升开发者的工作效率。

### 核心价值
- 🤖 **智能对话**：理解上下文，提供精准的代码建议
- 🛠️ **丰富工具**：20+ 内置工具，支持文件操作、代码搜索、Git 集成等
- 🌐 **双模式界面**：CLI 终端 + Web UI，适应不同使用场景
- 🔗 **可扩展性**：通过 MCP 协议支持外部工具集成

### 设计理念
- **用户体验优先**：简洁直观的交互设计
- **稳定可靠**：完善的错误处理和状态管理
- **性能优化**：智能压缩、增量更新、高效缓存
- **开放生态**：插件系统、自定义命令、技能扩展

## WHAT: 技术栈

### 核心技术
- **运行时**: Node.js >= 20.0.0
- **开发工具**: Bun 1.3.11（开发时）
- **语言**: TypeScript（严格模式）
- **UI 框架**: 
  - CLI: React 19 + Ink 6
  - Web: React 19 + Vite
- **状态管理**: Zustand
- **测试**: Vitest
- **代码质量**: Biome (Lint + Format)

### 项目结构
```
packages/
├── cli/                 # 核心 CLI 工具
│   ├── src/
│   │   ├── agent/       # Agent 核心（无状态）
│   │   ├── tools/       # 工具系统
│   │   ├── server/      # Web 服务器
│   │   ├── mcp/         # MCP 协议支持
│   │   ├── ui/          # UI 组件
│   │   ├── utils/       # 工具函数
│   │   └── ...
│   └── tests/           # 测试文件
└── vscode/              # VSCode 扩展
```

## HOW: 核心开发工作流

### 快速开始

```bash
# 开发
bun run dev              # CLI 开发模式
bun run dev:web          # CLI + Web 开发模式

# 测试
bun run test:unit        # 单元测试
bun run test:integration # 集成测试
bun run test:all         # 所有测试

# 质量检查
bun run type-check       # 类型检查
bun run lint             # Lint 检查
bun run format:check     # 格式检查
bun run ready            # 发布前全面检查

# 构建和发布
bun run build            # 构建项目
bun run release          # 发布新版本
```

### 核心设计原则

1. **无状态 Agent**
   - Agent 不存储会话状态
   - 所有状态通过 context 传递
   - 易于测试和调试

2. **工具系统**
   - 统一的工具注册和执行机制
   - 使用 Zod 进行参数验证
   - 三级权限控制（allow/ask/deny）

3. **会话管理**
   - 多会话支持
   - 会话持久化和恢复
   - 会话 Fork 功能

4. **智能压缩**
   - 自动检测上下文溢出
   - 保护重要消息和工具调用
   - 可配置的压缩策略

### 关键概念

#### @ 文件引用系统
用户可以通过 `@` 语法快速引用文件：
```
@src/utils.ts           # 引用整个文件
@src/utils.ts:10-20     # 引用第 10-20 行
@src/utils.ts:15        # 引用第 15 行
@src/components/        # 引用整个目录
```

#### 工具系统
- **Read**: 读取文件
- **Write**: 创建文件
- **Edit**: 编辑文件
- **Bash**: 执行命令
- **Grep**: 搜索代码
- **Git**: Git 操作
- ...20+ 工具

#### 权限模式
- `default`: 默认模式，需要确认
- `autoEdit`: 自动编辑模式
- `plan`: 计划模式
- `yolo`: YOLO 模式（谨慎使用）
- `spec`: 规格模式

### 代码风格

```typescript
// 使用 Zod 进行参数验证
const schema = z.object({
  path: z.string(),
  content: z.string(),
});

// 避免使用 any
function processData(data: unknown): Result {
  // ...
}

// 使用完整的类型定义
interface ToolContext {
  cwd: string;
  session: Session;
  permissions: Permissions;
}

// 优先使用 async/await
async function executeCommand(cmd: string): Promise<Result> {
  // ...
}
```

### 测试策略

1. **单元测试**：测试独立的函数和类
2. **集成测试**：测试模块间的交互
3. **E2E 测试**：测试完整的用户工作流
4. **TDD 优先**：先写测试，再实现功能

### 重要提醒

⚠️ **注意事项**:
- Agent 返回的文本是实际操作，不是人类可读的消息
- 使用 `pathe` 而不是 `path` 以确保跨平台兼容性
- 工具类以 'Tool' 后缀命名
- 会话数据存储在全局配置目录
- 支持交互式和静默（非交互式）模式

### 参与贡献

1. Fork 项目
2. 创建功能分支
3. 编写测试（TDD）
4. 实现功能
5. 运行 `bun run ready` 确保质量
6. 提交 PR

---

**更多信息**:
- [README.md](README.md) - 项目概述
- [CONTRIBUTING.md](CONTRIBUTING.md) - 贡献指南
- [DEVELOPMENT.md](DEVELOPMENT.md) - 开发工作流
- [BLADE.md](BLADE.md) - 项目详细文档
