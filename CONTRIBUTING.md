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
   bun install
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
   bun run dev        # 启动 CLI 开发模式（watch）
   bun run dev:web    # 启动 CLI + Web 服务器
   ```

3. **测试 Web UI**：
   ```bash
   # 构建后启动 Web UI
   bun run build
   blade web          # 启动 Web UI 并打开浏览器
   blade serve        # 启动无头服务器模式
   ```

4. **代码质量检查**：
   ```bash
   bun run lint       # 运行 linting 检查
   bun run type-check # TypeScript 类型检查
   bun run test:all   # 运行测试
   ```

5. **构建验证**：
   ```bash
   bun run build      # 构建 CLI
   ```

#### 代码规范

- **TypeScript**：使用严格的 TypeScript 配置
- **代码风格**：使用 Biome 进行格式化和 linting
- **提交规范**：使用清晰的提交信息
- **测试覆盖**：为新功能添加相应的测试

#### 测试要求

- **单元测试**：`bun run test:unit`
- **集成测试**：`bun run test:integration`
- **真实 API 测试**：`bun run test:real-api`（读取 `~/.blade/config.json` 当前模型）
- **CLI 测试**：`bun run test:cli`
- **覆盖率报告**：`bun run test:coverage`

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
│   ├── cli/            # blade-code - CLI 核心工具（npm 包）
│   │   ├── src/
│   │   │   ├── agent/          # Agent 核心逻辑
│   │   │   ├── commands/       # CLI 子命令（serve、web、mcp 等）
│   │   │   ├── server/         # Web 服务器（Hono）
│   │   │   ├── config/         # 配置管理
│   │   │   ├── context/        # 上下文管理
│   │   │   ├── mcp/            # MCP 协议
│   │   │   ├── prompts/        # 提示模板
│   │   │   ├── services/       # 核心服务（Chat、Session 等）
│   │   │   ├── slash-commands/ # 斜杠命令
│   │   │   ├── skills/         # Skills 系统
│   │   │   ├── hooks/          # Hooks 系统
│   │   │   ├── spec/           # Spec 模式
│   │   │   ├── tools/          # 工具系统
│   │   │   ├── ui/             # 终端 UI（React + Ink）
│   │   │   ├── store/          # 状态管理（Zustand）
│   │   │   └── blade.tsx       # 应用入口
│   │   └── tests/              # 测试文件
│   └── vscode/         # blade-vscode - VSCode 扩展
├── docs/               # 用户文档（Docsify）
├── .blade/             # 项目级配置
│   ├── commands/       # 自定义 Slash 命令
│   └── skills/         # 自定义 Skills
└── package.json        # 根 package.json
```

### 设计原则

- **模块化**：每个模块有清晰的职责边界
- **类型安全**：全面的 TypeScript 类型覆盖
- **可测试性**：便于单元测试和集成测试
- **扩展性**：支持插件和外部集成

## 🔄 发布流程

Blade Code 的详细发布流程以 [AGENTS.md](AGENTS.md#release-process) 为权威来源，
下面是贡献者需要了解的核心约束：

- **版本权威**：只有 `packages/cli/package.json` 的版本号会被 npm 识别为发布版本，
  根目录 `package.json` 的版本仅用于 monorepo 元数据。
- **一次一个版本**：每个独立功能或修复以单独的 patch 版本发布，并串行推送 tag，
  避免 npm `latest` 竞态。
- **双语变更日志**：`CHANGELOG.md`（英文，权威源）与 `CHANGELOG.zh.md`（中文，手工同步）
  必须包含相同的版本标题和等价内容。
- **预 tag 校验脚本**：在打 tag 之前，必须在候选 commit 上成功运行
  [scripts/verify-release-candidate.sh](scripts/verify-release-candidate.sh)。
  它会检查工作树是否干净、双语 changelog 是否齐备、tag/npm 版本是否冲突，
  并依次执行 `bun install --frozen-lockfile`、`bun run build`、`bun run test:all`、
  `bun run lint`、`bun run type-check`。
- **OIDC 可信发布**：`.github/workflows/publish.yml` 使用 npm Trusted Publishing
  通过 OIDC 发布，禁止使用长期 npm token，也不要新增 `npm dist-tag add` 步骤
  （除非 Trusted Publisher 已显式授予 **Allow npm dist-tag**）。
- **故障恢复**：若 `npm publish` 成功而后续步骤失败，不得改写 tag 或重复发布同一版本；
  只补齐缺失的 GitHub Release，并在下一个 patch 版本中修复 workflow。

完整的候选资格、tag 创建、推送、监控与发布后验证步骤，请参考 [AGENTS.md](AGENTS.md#release-process)。

## 📞 联系我们

- **GitHub Issues**：技术问题和 bug 报告
- **Discussions**：功能讨论和使用交流

## 📄 许可证

通过贡献代码，您同意您的贡献将在 MIT 许可证下发布。

---

再次感谢您的贡献！🎉
