# 发布指南

Blade Code 使用 **Git Tag 触发自动发布**的方式进行版本发布。

## 快速发布

使用发布脚本（推荐）：

```bash
./scripts/release.sh
```

脚本会引导你完成整个发布流程：
1. 输入新版本号
2. 自动更新 package.json
3. 创建 git commit 和 tag
4. 推送到 GitHub
5. 触发自动发布

## 手动发布

如果你想手动控制每一步：

### 1. 更新版本号

```bash
cd packages/cli
npm version patch  # 或 minor, major
cd ../..
```

### 2. 提交更改

```bash
git add packages/cli/package.json
git commit -m "chore(release): v0.x.x"
```

### 3. 创建 tag

```bash
git tag -a v0.x.x -m "Release v0.x.x"
```

### 4. 推送

```bash
git push origin main
git push origin v0.x.x
```

### 5. 监控发布

- GitHub Actions: https://github.com/echoVic/blade-code/actions
- npm 包: https://www.npmjs.com/package/blade-code

## 版本号规则

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **MAJOR** (1.0.0): 不兼容的 API 变更
- **MINOR** (0.1.0): 向后兼容的功能新增
- **PATCH** (0.0.1): 向后兼容的问题修复

## 发布前检查

运行质量检查脚本确保代码可发布：

```bash
bun run ready
```

该脚本会运行：
- ✅ 类型检查
- ✅ 格式检查
- ✅ Lint 检查
- ✅ 单元测试
- ✅ 集成测试
- ✅ 构建检查

## 发布流程

当你推送 tag 后：

1. **触发 GitHub Actions**：`.github/workflows/publish.yml`
2. **运行测试**：确保代码质量
3. **构建包**：编译 TypeScript
4. **发布到 npm**：自动发布（需要 NPM_TOKEN secret）
5. **创建 GitHub Release**：生成发布说明

## 配置 NPM_TOKEN

首次发布需要配置 npm 认证令牌：

### 方法 1：使用 GitHub CLI（推荐）

```bash
./packages/cli/scripts/get-npm-token.sh
```

### 方法 2：手动配置

1. 从 ~/.npmrc 获取 token
2. 在 GitHub 仓库设置中添加 secret `NPM_TOKEN`

详见：[GitHub CLI使用指南.md](docs/GitHub_CLI使用指南.md)

## 故障排除

### 发布失败

检查 GitHub Actions 日志：
```bash
gh run list --workflow=publish.yml
gh run view <run-id> --log
```

### 版本冲突

如果 npm 上已存在该版本：
```bash
git tag -d v0.x.x                    # 删除本地 tag
git push origin :refs/tags/v0.x.x    # 删除远程 tag
```

然后使用新版本号重新发布。

### 回滚发布

npm 不支持删除已发布的版本，但可以废弃：
```bash
npm deprecate blade-code@0.x.x "版本有问题，请使用最新版"
```
