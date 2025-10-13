# 🗡️ Blade 文档中心

欢迎来到 Blade Code 项目文档！这是一个现代化的 AI 命令行工具，支持智能对话、工具调用、权限管理等功能。

## 📚 文档导航

### 👥 按受众分类

| 受众 | 文档入口 | 说明 |
|------|---------|------|
| **用户** | [用户文档](public/README.md) | 安装、配置、使用指南 |
| **开发者** | [开发者文档](development/README.md) | 架构设计、技术实现 |
| **贡献者** | [贡献指南](contributing/README.md) | 参与开源贡献 |

### 🚀 快速链接

#### 新用户
- [安装指南](public/getting-started/installation.md) - 如何安装 Blade
- [快速开始](public/getting-started/quick-start.md) - 5 分钟上手
- [常见问题](public/faq.md) - FAQ

#### 核心功能
- [配置系统](public/configuration/config-system.md) ⭐ - 双文件配置系统
- [权限控制](public/configuration/permissions.md) ⭐ - 三级权限管理
- [工具列表](public/reference/tool-list.md) - 所有可用工具
- [CLI 命令](public/reference/cli-commands.md) - 命令行参考

#### 技术架构
- [工具系统](development/architecture/tool-system.md) ⭐ - 工具系统架构
- [执行管道](development/architecture/execution-pipeline.md) ⭐ - 6 阶段执行流程
- [Agent 架构](development/architecture/agent.md) - Agent 核心设计
- [确认流程](development/architecture/confirmation-flow.md) - 用户确认机制

#### 参与贡献
- [PR 指南](contributing/pr-creation-guide.md) - 如何提交 PR
- [发布流程](contributing/release-process.md) - 版本发布
- [代码规范](contributing/README.md#-开发规范) - 开发规范

## 📖 文档结构

```
docs/
├── public/              📱 用户文档（通过 Docsify 展示）
│   ├── getting-started/ - 快速开始
│   ├── configuration/   - 配置指南
│   ├── guides/          - 使用指南
│   └── reference/       - 参考文档
│
├── development/         🔧 开发者文档（内部技术）
│   ├── architecture/    - 架构设计
│   ├── implementation/  - 实现细节
│   ├── planning/        - 技术方案
│   └── testing/         - 测试文档
│
├── contributing/        🤝 贡献者文档（开源贡献）
│   ├── pr-creation-guide.md
│   ├── release-process.md
│   └── security-policy.md
│
└── archive/             📦 归档文档（历史参考）
```

## 🌐 在线文档

### 用户文档网站

访问 Docsify 构建的用户文档:

**本地预览**:
```bash
npm install -g docsify-cli
docsify serve docs/public
```

然后访问 http://localhost:3000

## 🔍 按角色推荐

**我是新用户** 👤
1. [安装指南](public/getting-started/installation.md)
2. [快速开始](public/getting-started/quick-start.md)
3. [配置系统](public/configuration/config-system.md)
4. [常见问题](public/faq.md)

**我是开发者** 👨‍💻
1. [开发者文档首页](development/README.md)
2. [工具系统架构](development/architecture/tool-system.md)
3. [执行管道](development/architecture/execution-pipeline.md)
4. [测试指南](development/testing/index.md)

**我想贡献代码** 🤝
1. [贡献指南](contributing/README.md)
2. [PR 创建指南](contributing/pr-creation-guide.md)
3. [开发者文档](development/README.md)

## 🔗 相关资源

- **项目主页**: https://github.com/echoVic/blade-code
- **NPM 包**: https://www.npmjs.com/package/blade-code
- **更新日志**: [CHANGELOG](../CHANGELOG.md)

---

最后更新: 2025-10-13
