#!/bin/bash
set -e

# 发布脚本 - 通过 git tag 触发自动发布

echo "🚀 Blade Code 发布脚本"
echo ""

# 获取当前版本
CURRENT_VERSION=$(node -p "require('./packages/cli/package.json').version")
echo "📦 当前版本: v$CURRENT_VERSION"
echo ""

# 提示输入新版本
echo "请输入新版本号 (格式: x.y.z):"
read NEW_VERSION

if [[ ! $NEW_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ 版本号格式错误，应为 x.y.z"
    exit 1
fi

echo ""
echo "📝 将要发布的版本: v$NEW_VERSION"
echo ""
echo "⚠️  此操作将："
echo "  1. 更新 packages/cli/package.json 中的版本号"
echo "  2. 提交版本更新"
echo "  3. 创建 git tag: v$NEW_VERSION"
echo "  4. 推送到 GitHub"
echo "  5. 触发 GitHub Actions 自动发布到 npm"
echo ""
echo "是否继续? (y/n)"
read CONFIRM

if [ "$CONFIRM" != "y" ]; then
    echo "❌ 已取消"
    exit 0
fi

# 更新版本号
echo ""
echo "📝 更新版本号..."
cd packages/cli
npm version $NEW_VERSION --no-git-tag-version
cd ../..

# 提交更改
echo "💾 提交更改..."
git add packages/cli/package.json
git commit -m "chore(release): v$NEW_VERSION"

# 创建 tag
echo "🏷️  创建 tag: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# 推送
echo "🚀 推送到 GitHub..."
git push origin main
git push origin "v$NEW_VERSION"

echo ""
echo "✅ 发布流程已启动！"
echo ""
echo "📊 查看发布进度: https://github.com/echoVic/blade-code/actions"
echo "📦 查看 npm 包: https://www.npmjs.com/package/blade-code"
