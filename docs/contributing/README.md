# 🤝 Blade 贡献指南

感谢你对 Blade Code 的关注！我们欢迎所有形式的贡献。

## 📖 贡献文档

- **[PR 创建指南](pr-creation-guide.md)** ⭐ - 如何提交 Pull Request
- **[发布流程](release-process.md)** - 版本发布流程
- **[安全政策](security-policy.md)** - 安全配置和最佳实践

## 🚀 快速开始

### 1. Fork 和克隆

```bash
# Fork 项目到你的账号
# 然后克隆到本地
git clone https://github.com/YOUR_USERNAME/blade-code.git
cd blade-code
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 开发

```bash
# 启动开发模式
pnpm dev

# 运行测试
pnpm test

# 代码检查
pnpm check:fix

# 类型检查
pnpm type-check
```

### 4. 提交 PR

详见 [PR 创建指南](pr-creation-guide.md)

## 📋 贡献类型

### 🐛 Bug 修复
1. 在 [Issues](https://github.com/echoVic/blade-code/issues) 中搜索是否已存在
2. 如没有，创建新 Issue 描述问题
3. Fork 项目并创建修复分支
4. 提交 PR 并关联 Issue

### ✨ 新功能
1. 先创建 Feature Request Issue 讨论
2. 等待维护者反馈
3. 获得批准后再开始开发
4. 提交 PR 并包含完整的测试和文档

### 📝 文档改进
1. 直接提交 PR
2. 说明改进的原因
3. 确保链接和格式正确

### 🧪 测试增强
1. 提高测试覆盖率
2. 添加缺失的测试用例
3. 改进测试质量

## 🎯 开发规范

### 代码风格

项目使用 Biome 进行代码检查和格式化：

```bash
# 自动修复问题
pnpm check:fix
```

**规范要点**:
- 使用单引号
- 语句结尾加分号
- 最大行宽 88 字符
- 使用 2 空格缩进

### 提交信息

遵循 Conventional Commits 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**类型**:
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例**:
```
feat(tools): 添加新的文件搜索工具

- 实现基于 glob 模式的文件搜索
- 支持排除特定目录
- 添加完整的单元测试

Closes #123
```

### 测试要求

- 新功能必须包含测试
- Bug 修复必须添加回归测试
- 保持测试覆盖率 ≥ 80%
- 所有测试必须通过

```bash
# 运行测试
pnpm test

# 查看覆盖率
pnpm test:coverage
```

### 文档要求

- 新功能必须更新相关文档
- API 变更必须更新 API 文档
- 重大变更必须更新 CHANGELOG
- 示例代码必须可运行

## 🔍 审查流程

1. **自动检查**: CI 会自动运行测试和代码检查
2. **代码审查**: 维护者会审查你的代码
3. **讨论修改**: 根据反馈进行调整
4. **合并**: 审查通过后合并到主分支

## 💡 开发技巧

### 调试

```bash
# 启用调试模式
export BLADE_DEBUG=1
pnpm dev
```

### 查看架构文档

开发前建议阅读：
- [工具系统架构](../development/architecture/tool-system.md)
- [执行管道架构](../development/architecture/execution-pipeline.md)
- [Agent 架构](../development/architecture/agent.md)

### 运行特定测试

```bash
# 运行单个测试文件
pnpm test path/to/test.ts

# 运行匹配模式的测试
pnpm test --grep "工具系统"
```

## 📞 获取帮助

- 💬 [GitHub Discussions](https://github.com/echoVic/blade-code/discussions) - 提问和讨论
- 🐛 [GitHub Issues](https://github.com/echoVic/blade-code/issues) - 报告 Bug
- 📧 Email: 联系维护者

## 🙏 致谢

感谢所有为 Blade Code 做出贡献的开发者！

查看完整的贡献者列表: [Contributors](https://github.com/echoVic/blade-code/graphs/contributors)

---

再次感谢你的贡献！🎉
