# 🗡️ Blade 文档

Blade是一款基于**平铺三要素配置**的AI命令行工具，支持任意开放AI协议的大模型。

## 📚 文档目录

- [首页](./index.md) - 文档索引
- [快速开始](./QUICK_START.md) - 三步上手指南
- [配置系统](./CONFIGURATION.md) - 分层配置详解
- [主题系统](./THEMES.md) - 13种内置主题和自定义主题
- [命令参考](./COMMANDS.md) - CLI命令大全
- [API文档](./API.md) - 编程接口参考

## 🎯 核心特性

### ✨ 分层配置架构
- **用户配置**: `~/.blade/config.json` (API密钥等敏感信息)
- **项目配置**: `./.blade/settings.local.json` (功能开关等项目设置)

### 🚀 极简调用
```bash
# 环境变量方式
export BLADE_API_KEY="sk-xxx"
blade chat "你好，世界！"

# 配置文件方式  
echo '{"apiKey":"sk-xxx"}' > ~/.blade/config.json
blade chat "你好，世界！"
```

### 📦 开箱即用
- 支持任意开放AI协议模型
- 环境变量、配置文件、CLI参数三重配置
- 自动重试和流式输出
- 极简CLI接口设计

## 🛠️ 安装使用

```bash
# 全局安装
npm install -g blade-ai

# 或者免安装使用
npx blade-ai chat "你好"
```

## 🔧 支持功能

- 💬 智能问答对话
- 💻 代码生成辅助
- 📚 文本内容创作
- 🛠️ 实用工具集
- 🔄 流式实时输出
- 🎮 交互式对话

---
@2025 Blade AI