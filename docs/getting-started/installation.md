# 📦 安装指南

## 🚀 安装方式

### 1. 零安装试用

无需安装，直接使用 npx 体验：

```bash
npx blade-code
npx blade-code "你好，介绍一下自己"
npx blade-code --print "解释什么是 TypeScript"
```

> 💡 首次运行需配置模型，输入 `/model add` 进入向导。

### 2. 全局安装（推荐）

```bash
# npm
npm install -g blade-code

# pnpm
pnpm add -g blade-code

# yarn
yarn global add blade-code
```

安装后即可使用 `blade` 命令：

```bash
# CLI 模式
blade                    # 进入交互式界面
blade "帮我分析代码"      # 带首条消息启动
blade --print "你好"     # 打印模式

# Web UI 与服务器模式
blade web                # 启动 Web UI 并打开浏览器
blade serve              # 启动无头服务器
```

### 3. 项目本地安装

```bash
npm install blade-code
npx blade "帮我分析代码"
```

## 🔐 配置模型

首次启动需配置模型，有以下方式：

### 向导配置

首次运行 `blade` 时输入 `/model add`，依次选择：

1. Provider
2. Provider Catalog 中的模型
3. Provider 凭证（尚未配置时）

Provider、模型、默认 endpoint、context window 和价格由内置目录动态提供。

### 手动配置示例

也可手动编辑 `~/.blade/config.json`：

```json
{
  "currentModelId": "primary",
  "models": [
    {
      "id": "primary",
      "displayName": "DeepSeek Pro",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    }
  ]
}
```

API Key 由向导写入 `~/.blade/auth.json`，不会进入 `config.json`。

### 获取 API 密钥

- **千问**: [DashScope 控制台](https://dashscope.console.aliyun.com/apiKey)
- **DeepSeek**: [DeepSeek 平台](https://platform.deepseek.com/api_keys)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)
- **Anthropic**: [Anthropic Console](https://console.anthropic.com/)
- **Google Gemini**: [Google AI Studio](https://aistudio.google.com/apikey)

## ✅ 验证安装

```bash
blade --version    # 查看当前安装版本
blade --help       # 查看帮助
blade doctor       # 环境检查
blade --print "测试一下"  # 测试 API 连接
blade web          # 测试 Web UI
```

## 🔧 系统要求

- **Node.js**: ≥ 22.19.0
- **终端**: 支持 UTF-8 和彩色输出
- **系统**: macOS / Linux / Windows 10+

## 🐛 常见问题

### 权限错误（EACCES）

```bash
# 方案 1：使用 sudo
sudo npm install -g blade-code

# 方案 2：修改 npm 全局目录
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
# 将上面的 export 添加到 ~/.bashrc 或 ~/.zshrc
```

### Node.js 版本过低

```bash
# 使用 nvm
nvm install 22.19 && nvm use 22.19

# 或使用 n
npm install -g n && n latest
```

### 网络慢 / 安装失败

```bash
# 使用国内镜像
npm install -g blade-code --registry=https://registry.npmmirror.com
```

### 配置/密钥问题

```bash
# 检查配置和运行环境
blade doctor

# 查看不含凭据的模型配置
cat ~/.blade/config.json
```

## 🔄 更新和卸载

### 更新到最新版本

```bash
# 检查更新
blade update

# 手动更新
npm update -g blade-code

# 安装指定版本
npm install -g blade-code@latest
```

### 卸载

```bash
# 卸载全局安装
npm uninstall -g blade-code

# 清理配置文件（可选）
rm -rf ~/.blade
```

## 🎯 下一步

安装完成后，建议：

1. [阅读快速开始指南](quick-start.md) - 5 分钟上手
2. [了解配置系统](../configuration/config-system.md) - 深入配置
3. [查看工具列表](../reference/tool-list.md) - 了解可用工具
