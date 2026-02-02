# 📦 安装指南

> **当前版本**: 0.2.0

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

# Web UI 模式（0.2.0 新增）
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

首次运行 `blade` 时输入 `/model add` 进入模型配置向导，依次填写：

1. **配置名称** - 用于标识此模型配置
2. **Provider** - 选择提供商类型
3. **Base URL** - API 端点地址
4. **API Key** - 密钥（隐藏输入）
5. **模型名称** - 具体模型标识

### 支持的 Provider

| Provider | 说明 | 示例 |
|----------|------|------|
| `openai-compatible` | OpenAI 兼容接口 | Qwen、DeepSeek、Ollama、OpenRouter |
| `anthropic` | Anthropic Claude | Claude 3.5/4 系列 |
| `gemini` | Google Gemini | Gemini 1.5/2.0 系列 |
| `azure-openai` | Azure OpenAI Service | GPT-4o 等 |
| `copilot` | GitHub Copilot | OAuth 认证 |
| `antigravity` | Google Antigravity | OAuth 认证 |

### 手动配置示例

也可手动编辑 `~/.blade/config.json`：

```json
{
  "currentModelId": "qwen",
  "models": [
    {
      "id": "qwen",
      "name": "Qwen",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max"
    }
  ]
}
```

> 💡 推荐把密钥放在环境变量中，再用 `${VAR}` 插值，避免明文存储。

### 获取 API 密钥

- **千问**: [DashScope 控制台](https://dashscope.console.aliyun.com/apiKey)
- **DeepSeek**: [DeepSeek 平台](https://platform.deepseek.com/api_keys)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)
- **Anthropic**: [Anthropic Console](https://console.anthropic.com/)
- **Google Gemini**: [Google AI Studio](https://aistudio.google.com/apikey)

## ✅ 验证安装

```bash
blade --version    # 查看版本（应显示 0.2.0）
blade --help       # 查看帮助
blade doctor       # 环境检查
blade --print "测试一下"  # 测试 API 连接
blade web          # 测试 Web UI（0.2.0 新增）
```

## 🔧 系统要求

- **Node.js**: ≥ 20.0.0
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
nvm install 20 && nvm use 20

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
# 检查配置文件
cat ~/.blade/config.json
cat .blade/config.json

# 检查环境变量
echo $QWEN_API_KEY
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
