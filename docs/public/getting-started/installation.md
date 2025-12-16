# 📦 安装使用指南

## 🚀 安装方式

### 1）零安装试用

```bash
npx blade-code "你好，介绍一下自己"
npx blade-code --print "解释什么是 TypeScript"
```

### 2）全局安装（推荐）

```bash
npm install -g blade-code   # 或 pnpm add -g / yarn global add

blade            # 进入交互式界面
blade --print "你好"  # 打印模式
```

### 3）项目本地安装

```bash
npm install blade-code   # 或 pnpm/yarn 对等命令
npx blade "帮我分析代码"
```

## 🔐 配置模型与密钥

首次运行 `blade` 如未检测到模型配置，会自动弹出模型配置向导（`ModelConfigWizard`），依次填写：
1. 配置名称
2. Provider（`openai-compatible` / `anthropic`）
3. Base URL
4. API Key（隐藏输入）
5. 模型名称

向导完成后会写入 `~/.blade/config.json`，后续可在 UI 内随时输入 `/model add` 新增或编辑。

也可手动写配置文件（示例）：

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

推荐把密钥放在环境变量中，再用 `${VAR}` 插值。支持用户级 `~/.blade/config.json` 与项目级 `.blade/config.json`。

## ✅ 验证

```bash
blade --version
blade --help
blade --print "测试一下"
```

## 🔧 系统要求

- Node.js ≥ 18（推荐 20+）
- 现代终端，UTF-8/彩色输出支持
- macOS / Linux / Windows 10+

## 🐛 常见问题

### 权限错误（EACCES）
```bash
sudo npm install -g blade-code
# 或
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
```

### Node.js 版本过低
```bash
nvm install 20 && nvm use 20
# 或
npm install -g n && n latest
```

### 网络慢 / 安装失败
```bash
npm install -g blade-code --registry=https://registry.npmmirror.com
```

### 配置/密钥问题
```bash
cat ~/.blade/config.json
cat .blade/config.json
echo $QWEN_API_KEY
```

支持的 IDE：
- Visual Studio Code
- WebStorm/IntelliJ IDEA
- Vim/Neovim
- Emacs
- Cursor

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

# 清理环境变量（手动编辑配置文件）
# 从 ~/.bashrc 或 ~/.zshrc 中移除 QWEN_API_KEY 等配置
```

## 🎯 下一步

安装完成后，建议：

1. [阅读快速开始指南](quick-start.md)
2. [学习基础命令](../cli/commands.md)
3. [了解配置设置](../cli/configuration.md)
4. [查看常见问题](faq.md)

---

现在你已经成功安装了 Blade Code！🎉
