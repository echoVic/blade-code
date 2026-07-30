# 🚀 自动发版快速指南

## 一键设置

```bash
bash scripts/setup-auto-release.sh
```

## 配置步骤

### 1️⃣ 获取 NPM Token

**方法一：使用自动化脚本（推荐）**

```bash
# 1. 登录 npm
npm login

# 2. 运行配置脚本（自动提取 token）
bash scripts/get-npm-token.sh
# Token 会自动复制到剪贴板（Mac）并显示配置步骤
```

**方法二：手动创建**

1. 登录 npm: `npm login`
2. 访问: https://www.npmjs.com/settings/YOUR_USERNAME/tokens
3. 点击 "Generate New Token" → 选择 "Automation"
4. 复制生成的 token

### 2️⃣ 添加 GitHub Secret

**方法一：使用 GitHub CLI（推荐，最快）**

```bash
# 前提：已安装 gh CLI
# brew install gh  # macOS
# gh auth login    # 登录

# 运行配置脚本，选择 'y' 自动添加
bash scripts/get-npm-token.sh

# 或者手动命令
echo "YOUR_TOKEN" | gh secret set NPM_TOKEN
```

**方法二：通过网页添加**

1. 访问仓库设置: `Settings` → `Secrets and variables` → `Actions`
2. 点击 "New repository secret"
3. 添加 secret:
   - **Name**: `NPM_TOKEN`
   - **Value**: 粘贴你的 npm token
4. 点击 "Add secret"

> 💡 提示：GitHub CLI 方法无需打开浏览器，更快更安全！  
> 📚 详细指南：[GitHub CLI 使用指南](docs/GitHub_CLI使用指南.md)

### 3️⃣ 提交配置文件

```bash
git add .github/ docs/ scripts/
git commit -m "ci: setup automated release workflow"
git push origin main
```

### 4️⃣ 开始使用

从现在开始，使用规范的 commit 消息：

```bash
# 新功能 (触发 minor 版本: 0.4.2 → 0.5.0)
git commit -m "feat: 添加新功能"

# Bug 修复 (触发 patch 版本: 0.4.2 → 0.4.3)
git commit -m "fix: 修复某个问题"

# 重大变更 (触发 major 版本: 0.4.2 → 1.0.0)
git commit -m "feat!: 重大变更"
# 或
git commit -m "feat: 重大变更

BREAKING CHANGE: 详细说明"
```

### 5️⃣ 自动发布流程

1. **推送代码**到 main 分支
2. **Release Please** 自动分析 commits
3. **自动创建** Release PR（包含版本更新和 CHANGELOG）
4. **审查并合并** Release PR
5. **自动发布**到 npm 和创建 GitHub Release

## 📊 两种方案对比

### 方案一：Release Please（已配置，推荐）

✅ 自动生成 CHANGELOG  
✅ 自动更新版本号  
✅ 基于 Conventional Commits  
✅ 自动创建 Release PR  

**文件**: `.github/workflows/release.yml`

### 方案二：Git Tag 触发（已配置，备用）

✅ 简单直接  
✅ 完全手动控制  

**使用方式**:
```bash
git tag v0.5.0
git push origin v0.5.0
```

**文件**: `.github/workflows/publish.yml`

## 📝 Commit 规范

| 类型 | 说明 | 版本影响 |
|------|------|----------|
| `feat:` | 新功能 | Minor (0.x.0) |
| `fix:` | Bug 修复 | Patch (0.0.x) |
| `feat!:` | 重大变更 | Major (x.0.0) |
| `docs:` | 文档更新 | 无 |
| `refactor:` | 重构 | 无 |
| `perf:` | 性能优化 | Patch |
| `test:` | 测试 | 无 |
| `build:` | 构建系统 | 无 |
| `ci:` | CI 配置 | 无 |
| `chore:` | 其他 | 无 |

## 🔍 查看发布状态

```bash
# GitHub Actions
https://github.com/YOUR_USERNAME/blade-code/actions

# npm 包信息
npm info blade-code

# 最新版本
npm view blade-code version
```

## 📚 详细文档

完整配置指南请查看: [docs/自动发版配置指南.md](docs/自动发版配置指南.md)

## ⚡ 示例

### 日常开发流程

```bash
# 1. 开发新功能
git checkout -b feat/awesome-feature

# 2. 提交代码（使用规范格式）
git add .
git commit -m "feat(cli): add awesome feature"

# 3. 推送并创建 PR
git push origin feat/awesome-feature
# 在 GitHub 创建 PR

# 4. 合并 PR 到 main
# Release Please 会自动创建 Release PR

# 5. 审查 Release PR 并合并
# 自动发布到 npm！
```

### 手动触发发布（方案二）

```bash
# 1. 更新版本
bun run release:minor  # 或 patch/major

# 2. 提交
git add .
git commit -m "chore: release v0.5.0"

# 3. 创建 tag
git tag v0.5.0

# 4. 推送
git push origin main
git push origin v0.5.0

# 自动发布！
```

## 🐛 常见问题

### Q: Release Please 没有创建 PR？
A: 检查 commit 消息是否符合 Conventional Commits 规范

### Q: npm 发布失败？
A: 检查 NPM_TOKEN 是否正确设置，是否有权限发布该包

### Q: 如何回滚发布？
A: 使用 `npm unpublish blade-code@version`（24小时内）

## 🎯 下一步

1. ✅ 配置 NPM_TOKEN
2. ✅ 提交配置文件
3. ✅ 使用规范的 commit
4. 🎉 享受自动发版！

---

**需要帮助？** 查看 [完整文档](docs/自动发版配置指南.md) 或提交 issue。
