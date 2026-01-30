# 🤝 贡献指南

感谢您对 Blade Code 项目的关注！我们欢迎各种形式的贡献。

## 📋 贡献方式

### 🐛 报告 Bug

如果您发现了 bug，请在 [GitHub Issues](https://github.com/echoVic/blade-code/issues) 中提交报告，包含以下信息：

- **环境信息**：操作系统、Node.js 版本、Blade 版本
- **复现步骤**：详细的操作步骤
- **期望行为**：您期望发生什么
- **实际行为**：实际发生了什么
- **错误信息**：完整的错误信息和堆栈跟踪

### 💡 功能建议

我们欢迎新功能建议！请在提交前：

1. 检查是否已有类似建议
2. 考虑功能的通用性和必要性
3. 提供详细的使用场景

### 🔧 代码贡献

#### 开发环境准备

1. **Fork 并克隆项目**：
   ```bash
   git clone https://github.com/echoVic/blade-code.git
   cd blade-code
   ```

2. **安装依赖**：
   ```bash
   pnpm install
   ```

3. **配置开发环境**：
   ```bash
   mkdir -p ~/.blade
   nano ~/.blade/config.json
   ```

#### 开发流程

1. **创建特性分支**：
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **开发模式**：
   ```bash
   pnpm dev:cli   # 启动 CLI 开发模式
   pnpm dev:web   # 启动 Web UI 开发模式
   pnpm dev       # 并行启动所有包
   ```

3. **代码质量检查**：
   ```bash
   pnpm lint          # 运行 linting 检查
   pnpm type-check    # TypeScript 类型检查
   pnpm test:all      # 运行测试
   ```

4. **构建验证**：
   ```bash
   pnpm build         # 构建所有包
   ```

#### 代码规范

- **TypeScript**：使用严格的 TypeScript 配置
- **代码风格**：使用 Biome 进行格式化和 linting
- **提交规范**：使用清晰的提交信息
- **测试覆盖**：为新功能添加相应的测试

#### 测试要求

- **单元测试**：`pnpm test:unit`
- **集成测试**：`pnpm test:integration`
- **CLI 测试**：`pnpm test:cli`
- **覆盖率报告**：`pnpm test:coverage`

#### Pull Request 指南

1. **确保代码质量**：
   - 所有测试通过
   - 类型检查无错误
   - 代码风格符合规范

2. **PR 描述应包含**：
   - 变更内容的清晰描述
   - 相关 Issue 的链接
   - 截图或 GIF（如果适用）
   - 测试计划

3. **PR 标题格式**：
   ```
   feat: 添加新的工具集成
   fix: 修复配置加载问题
   docs: 更新 README 文档
   test: 添加单元测试
   refactor: 重构 Agent 类
   ```

## 🏗️ 项目架构

### Monorepo 结构

```
Blade/
├── packages/
│   ├── cli/            # @blade/cli - CLI 核心工具
│   │   ├── src/
│   │   │   ├── agent/          # Agent 核心逻辑
│   │   │   ├── cli/            # CLI 配置和中间件
│   │   │   ├── commands/       # CLI 命令实现
│   │   │   ├── config/         # 配置管理
│   │   │   ├── context/        # 上下文管理
│   │   │   ├── ide/            # IDE 集成
│   │   │   ├── logging/        # 日志系统
│   │   │   ├── mcp/            # MCP 协议
│   │   │   ├── prompts/        # 提示模板
│   │   │   ├── services/       # 核心服务
│   │   │   ├── slash-commands/ # 斜杠命令
│   │   │   ├── tools/          # 工具系统
│   │   │   ├── ui/             # 用户界面
│   │   │   ├── utils/          # 工具函数
│   │   │   └── blade.tsx       # 应用入口
│   │   └── tests/              # 测试文件
│   ├── web/            # @blade/web - Web UI 前端
│   ├── vscode/         # @blade/vscode - VSCode 扩展
│   └── shared/         # @blade/shared - 共享代码
├── docs/               # 文档
├── pnpm-workspace.yaml # Workspace 配置
├── tsconfig.base.json  # 共享 TypeScript 配置
└── package.json        # 根 package.json
```

### 设计原则

- **模块化**：每个模块有清晰的职责边界
- **类型安全**：全面的 TypeScript 类型覆盖
- **可测试性**：便于单元测试和集成测试
- **扩展性**：支持插件和外部集成

## 🔄 发布流程

1. **版本规划**：遵循语义化版本控制
2. **代码审查**：所有 PR 需要代码审查
3. **测试验证**：完整的测试流程
4. **文档更新**：同步更新相关文档

## 📞 联系我们

- **GitHub Issues**：技术问题和 bug 报告
- **Discussions**：功能讨论和使用交流

## 📄 许可证

通过贡献代码，您同意您的贡献将在 MIT 许可证下发布。

---

再次感谢您的贡献！🎉
