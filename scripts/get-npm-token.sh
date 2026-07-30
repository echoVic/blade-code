#!/bin/bash

# NPM Token 配置助手

set -e

echo "🔑 NPM Token 配置助手"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 检查是否已登录 npm
if npm whoami &> /dev/null; then
  NPM_USER=$(npm whoami)
  echo "✅ 已登录 npm，用户名: $NPM_USER"
  echo ""
else
  echo "❌ 未登录 npm"
  echo ""
  echo "请先运行: npm login"
  exit 1
fi

# 提取 token
if [ -f ~/.npmrc ]; then
  TOKEN=$(grep "//registry.npmjs.org/:_authToken" ~/.npmrc | cut -d'=' -f2)

  if [ -n "$TOKEN" ]; then
    echo "✅ 找到 NPM Token"
    echo ""
    echo "Token (前 20 个字符): ${TOKEN:0:20}..."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 下一步操作："
    echo ""

    # 检查是否安装了 gh CLI
    if command -v gh &> /dev/null; then
      echo "✅ 检测到 GitHub CLI (gh)"
      echo ""
      echo "🚀 方式一：使用命令行添加（推荐）"
      echo ""
      echo "运行以下命令："
      echo "  echo \"$TOKEN\" | gh secret set NPM_TOKEN"
      echo ""

      # 询问是否立即添加
      read -p "是否立即添加到 GitHub Secrets? (y/n) " -n 1 -r
      echo ""
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        if echo "$TOKEN" | gh secret set NPM_TOKEN; then
          echo ""
          echo "✅ NPM_TOKEN 已成功添加到 GitHub Secrets！"
          echo ""
          echo "🎉 配置完成！现在可以使用自动发版了："
          echo "   git commit -m \"feat: your feature\""
          echo "   git push origin main"
          echo ""
          exit 0
        else
          echo ""
          echo "❌ 添加失败，请检查 gh 是否已登录"
          echo "   运行: gh auth login"
          echo ""
        fi
      fi
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
    fi

    echo "🌐 方式二：通过网页添加"
    echo ""
    echo "1. 复制完整的 Token:"
    echo "   $TOKEN"
    echo ""
    echo "2. 添加到 GitHub Secrets:"

    # 获取 GitHub 仓库信息
    if git remote get-url origin &> /dev/null; then
      REPO_URL=$(git config remote.origin.url)
      REPO_PATH=$(echo $REPO_URL | sed 's/.*github.com[:/]\(.*\)\.git/\1/')

      echo "   访问: https://github.com/$REPO_PATH/settings/secrets/actions"
    else
      echo "   访问: https://github.com/YOUR_USERNAME/YOUR_REPO/settings/secrets/actions"
    fi

    echo ""
    echo "3. 点击 'New repository secret'"
    echo "   - Name: NPM_TOKEN"
    echo "   - Value: [粘贴上面的 Token]"
    echo ""
    echo "4. 点击 'Add secret'"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "💡 提示："
    echo "   - Token 已复制到剪贴板（Mac）或显示在上面"
    echo "   - 建议创建 Automation 类型的 Token 用于 CI/CD"
    echo "   - Token 泄露后请立即在 npm 网站撤销"
    echo ""

    # Mac 下自动复制到剪贴板
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "$TOKEN" | pbcopy
      echo "✅ Token 已复制到剪贴板！"
      echo ""
    fi

  else
    echo "❌ 未找到 Token"
    echo ""
    echo "请运行: npm login"
    exit 1
  fi
else
  echo "❌ 未找到 ~/.npmrc 文件"
  echo ""
  echo "请运行: npm login"
  exit 1
fi

# 可选：直接测试 token
echo "🧪 测试 Token 是否有效..."
if npm whoami &> /dev/null; then
  echo "✅ Token 有效！"
else
  echo "❌ Token 无效或已过期"
  echo "请重新运行: npm login"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 配置完成！"
echo ""
