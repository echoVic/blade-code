# GitHub CLI 快速指南

## 📦 安装 GitHub CLI

### macOS
```bash
brew install gh
```

### Windows
```bash
# 使用 Scoop
scoop install gh

# 或使用 Winget
winget install --id GitHub.cli
```

### Linux
```bash
# Ubuntu/Debian
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh

# Fedora/CentOS
sudo dnf install gh
```

---

## 🔑 登录 GitHub

```bash
# 登录 GitHub
gh auth login

# 选择：
# - GitHub.com
# - HTTPS
# - Login with a web browser
# 然后在浏览器中完成授权
```

---

## 🚀 常用命令

### 管理 Secrets

```bash
# 添加 secret
gh secret set SECRET_NAME

# 从文件读取
gh secret set SECRET_NAME < secret.txt

# 从命令输出
echo "my-secret-value" | gh secret set SECRET_NAME

# 列出所有 secrets
gh secret list

# 删除 secret
gh secret remove SECRET_NAME
```

### NPM Token 快速设置

```bash
# 方式一：直接输入
gh secret set NPM_TOKEN
# 然后粘贴 token 并按 Ctrl+D

# 方式二：从 .npmrc 提取并设置
cat ~/.npmrc | grep authToken | cut -d'=' -f2 | gh secret set NPM_TOKEN

# 方式三：使用我们的脚本（推荐）
bash scripts/get-npm-token.sh
# 脚本会提示是否自动添加到 GitHub
```

### 其他常用命令

```bash
# 查看仓库信息
gh repo view

# 创建 PR
gh pr create

# 查看 PR 列表
gh pr list

# 查看 Actions 运行状态
gh run list

# 查看最近的 workflow 运行
gh run watch

# 创建 Release
gh release create v1.0.0

# 查看 issue 列表
gh issue list
```

---

## ⚡ 一键配置 NPM Token

### 完整流程

```bash
# 1. 安装 gh CLI（如果还没安装）
brew install gh  # macOS
# 或其他平台的安装命令

# 2. 登录 GitHub
gh auth login

# 3. 登录 npm
npm login

# 4. 运行配置脚本
bash scripts/get-npm-token.sh
# 选择 'y' 自动添加到 GitHub Secrets

# 完成！🎉
```

### 手动命令（如果不用脚本）

```bash
# 1. 登录 npm
npm login

# 2. 提取 token
TOKEN=$(cat ~/.npmrc | grep "//registry.npmjs.org/:_authToken" | cut -d'=' -f2)

# 3. 添加到 GitHub Secrets
echo "$TOKEN" | gh secret set NPM_TOKEN

# 4. 验证
gh secret list | grep NPM_TOKEN
```

---

## 🔍 验证配置

```bash
# 查看是否添加成功
gh secret list

# 输出应该包含：
# NPM_TOKEN  Updated YYYY-MM-DD
```

---

## 🐛 常见问题

### Q: `gh` 命令找不到？
```bash
# 检查是否安装
which gh

# 如果没安装，按上面的安装步骤安装
```

### Q: 提示未登录？
```bash
# 重新登录
gh auth login

# 检查登录状态
gh auth status
```

### Q: 权限不足？
```bash
# 刷新权限
gh auth refresh -s write:org

# 或重新登录
gh auth logout
gh auth login
```

### Q: 如何更新已存在的 secret？
```bash
# 直接 set 会覆盖
echo "new-token" | gh secret set NPM_TOKEN
```

### Q: 如何为特定仓库设置？
```bash
# 在仓库目录下运行
cd /path/to/repo
gh secret set NPM_TOKEN

# 或指定仓库
gh secret set NPM_TOKEN --repo owner/repo
```

---

## 📚 更多资源

- [GitHub CLI 官方文档](https://cli.github.com/manual/)
- [gh secret 文档](https://cli.github.com/manual/gh_secret)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)

---

## 💡 提示

使用 `gh` 命令行比网页操作更快：
- ✅ 不需要切换到浏览器
- ✅ 可以自动化脚本
- ✅ 支持批量操作
- ✅ 更安全（token 不会显示在屏幕上）

---

**推荐工作流**：
```bash
# 一次性设置
brew install gh          # 安装 gh CLI
gh auth login           # 登录 GitHub
npm login               # 登录 npm

# 以后每次配置新项目
bash scripts/get-npm-token.sh   # 一键配置
```
