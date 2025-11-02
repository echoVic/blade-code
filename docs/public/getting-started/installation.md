# 📦 安装使用指南

## 🚀 安装方式

### 方式1：零安装试用（推荐新手）

```bash
# 无需安装，直接试用
npx blade-code "你好，介绍一下自己"

# 启动交互式界面
npx blade-code

# 使用特定选项
npx blade-code --print "解释什么是TypeScript"
```

### 方式2：全局安装（推荐日常使用）

```bash
# 使用 npm 全局安装
npm install -g blade-code

# 使用 yarn 全局安装
yarn global add blade-code

# 使用 pnpm 全局安装
pnpm add -g blade-code

# 然后就可以使用了
blade "你好"

# 或者启动交互式界面
blade
```

### 方式3：项目本地安装

```bash
# 在项目中安装
npm install blade-code
# 或
yarn add blade-code
# 或
pnpm add blade-code

# 使用 npx 运行
npx blade "帮我分析代码"

# 或添加到 package.json 脚本
{
  "scripts": {
    "blade": "blade"
  }
}
```

## 🔐 API 密钥配置

安装后需要配置 API 密钥才能使用。首次运行 `blade` 时，如果未检测到有效密钥，会自动启动交互式设置向导，按照提示填写 Provider、Base URL、API Key 和模型即可。

### 获取 API 密钥

- **千问（推荐）**: [https://dashscope.console.aliyun.com/apiKey](https://dashscope.console.aliyun.com/apiKey)
- **火山引擎**: [https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)

### 配置方式

#### 方式1：环境变量（推荐）

```bash
# 配置千问 API 密钥
export QWEN_API_KEY="your-qwen-api-key"

# 配置火山引擎 API 密钥
export VOLCENGINE_API_KEY="your-volcengine-api-key"

# 永久配置（添加到 ~/.bashrc 或 ~/.zshrc）
echo 'export QWEN_API_KEY="your-qwen-api-key"' >> ~/.bashrc
source ~/.bashrc
```

#### 方式2：配置向导（首次启动自动出现）

```bash
blade
# 按照终端中的步骤依次选择 Provider、输入 Base URL、API Key、模型
```

#### 方式3：配置文件

```bash
# 用户级配置
mkdir -p ~/.blade
vim ~/.blade/config.json

# 项目级配置
mkdir -p .blade
vim .blade/config.json
```

#### 方式4：配置命令

```bash
# 使用交互式配置命令
blade config
```

## ✅ 验证安装

```bash
# 检查版本
blade --version

# 显示帮助信息
blade --help

# 快速测试（需要先配置 API 密钥）
blade "请告诉我现在几点了？"

# 启动交互式模式
blade
```

## 🔧 系统要求

### 最低要求
- **Node.js**: 18.0 或更高版本
- **操作系统**: Windows 10+, macOS 10.15+, Linux (Ubuntu 20.04+)
- **内存**: 至少 512MB 可用内存

### 推荐配置
- **Node.js**: 20.0 或更高版本
- **内存**: 1GB 或更多可用内存
- **终端**: 支持 UTF-8 和颜色显示的现代终端

## 🐛 常见安装问题

### 问题1：权限错误

```bash
# 错误信息：EACCES: permission denied
# 解决方案：使用 sudo 或配置 npm 前缀
sudo npm install -g blade-code

# 或者配置 npm 全局目录
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
```

### 问题2：Node.js 版本过低

```bash
# 使用 nvm 升级 Node.js
nvm install 20
nvm use 20

# 或使用 n 工具
npm install -g n
n latest
```

### 问题3：网络连接问题

```bash
# 使用国内镜像源
npm install -g blade-code --registry=https://registry.npmmirror.com

# 或配置 npm 镜像
npm config set registry https://registry.npmmirror.com
```

### 问题4：API 密钥配置问题

```bash
# 检查环境变量
echo $QWEN_API_KEY

# 检查配置文件
cat ~/.blade/config.json
# 如有项目级配置：
cat .blade/config.json

# 测试 API 连接
blade --debug "测试连接"
```

## 📱 IDE 集成

Blade Code 支持多种 IDE 集成：

```bash
# 检查 IDE 支持
blade doctor

# 安装 IDE 扩展（自动检测）
blade ide install
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
