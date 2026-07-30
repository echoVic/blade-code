#!/bin/bash

# Blade Code 自动发版设置脚本

set -e

echo "🚀 Blade Code 自动发版设置"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 检查是否在正确的目录
if [ ! -f "package.json" ]; then
  echo "❌ 错误：请在项目根目录运行此脚本"
  exit 1
fi

echo "✅ 配置文件已存在："
echo "   - .github/workflows/release.yml"
echo "   - .github/workflows/publish.yml"
echo "   - .github/release-please-config.json"
echo "   - .github/.release-please-manifest.json"
echo ""

echo "📝 下一步操作："
echo ""
echo "1. 获取 NPM Token："
echo "   - 访问: https://www.npmjs.com/settings/$(npm whoami 2>/dev/null || echo '<your-username>')/tokens"
echo "   - 创建 Automation Token"
echo ""
echo "2. 添加到 GitHub Secrets："
echo "   - 访问: https://github.com/$(git config remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/settings/secrets/actions"
echo "   - 点击 'New repository secret'"
echo "   - Name: NPM_TOKEN"
echo "   - Value: 粘贴你的 npm token"
echo ""
echo "3. 提交配置文件："
echo "   git add .github/"
echo "   git commit -m 'ci: setup automated release workflow'"
echo "   git push origin main"
echo ""
echo "4. 使用规范的 commit 消息："
echo "   feat: 添加新功能 (触发 minor 版本更新)"
echo "   fix: 修复 bug (触发 patch 版本更新)"
echo "   feat!: 重大变更 (触发 major 版本更新)"
echo ""
echo "5. 自动发布："
echo "   - 推送后 Release Please 会创建 Release PR"
echo "   - 审查并合并 PR"
echo "   - 自动发布到 npm！"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📚 详细文档: docs/自动发版配置指南.md"
echo ""
