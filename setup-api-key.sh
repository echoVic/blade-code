#!/bin/bash

# Blade AI API Key 设置脚本
echo "🚀 Blade AI API Key 配置助手"
echo "================================"

# 检查当前API Key设置
if [ -n "$BLADE_API_KEY" ]; then
    echo "✅ 当前已设置 BLADE_API_KEY: ${BLADE_API_KEY:0:10}..."
    echo ""
    read -p "是否要更新API Key? (y/N): " update_key
    if [[ ! "$update_key" =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

echo ""
echo "📋 支持的API服务商:"
echo "1. iFlow (推荐) - https://iflow.cn/"
echo "2. 阿里云千问 - https://dashscope.console.aliyun.com/apiKey"
echo "3. 火山方舟 - https://console.volcengine.com/ark/"
echo ""

read -p "请输入您的API Key: " api_key

if [ -z "$api_key" ]; then
    echo "❌ API Key不能为空"
    exit 1
fi

# 设置环境变量
export BLADE_API_KEY="$api_key"
echo "export BLADE_API_KEY=\"$api_key\"" >> ~/.bashrc
echo "export BLADE_API_KEY=\"$api_key\"" >> ~/.zshrc

echo ""
echo "✅ API Key 配置完成!"
echo "📝 已添加到 ~/.bashrc 和 ~/.zshrc"
echo ""
echo "🔄 请重新加载shell配置:"
echo "   source ~/.bashrc  # 或"
echo "   source ~/.zshrc"
echo ""
echo "🎯 然后重新启动 Blade:"
echo "   blade"
