# ❓ 常见问题

## 🚀 入门问题

### Q: 如何开始使用 Blade Code？

**A:** 有三种方式：

1. **零安装试用**（推荐新手）
   ```bash
   npx blade-code "你好，介绍一下自己"
   ```

2. **全局安装**（推荐日常使用）
   ```bash
   npm install -g blade-code
   blade "你好"
   ```

3. **项目本地安装**
   ```bash
   npm install blade-code
   npx blade "帮我分析代码"
   ```

### Q: 安装后提示 "command not found: blade"？

**A:** 这通常是 PATH 配置问题：

```bash
# 检查 npm 全局路径
npm config get prefix

# 确保该路径在 PATH 中，添加到 ~/.bashrc 或 ~/.zshrc
export PATH="$(npm config get prefix)/bin:$PATH"

# 重新加载配置
source ~/.bashrc
```

## 🔐 API 配置问题

### Q: API 密钥错误或无效？

**A:** 按以下步骤检查：

```bash
# 1. 检查环境变量
echo $QWEN_API_KEY
echo $VOLCENGINE_API_KEY

# 2. 检查配置文件
cat ~/.blade/config.json
cat .blade/config.json

# 3. 测试连接（启用调试模式）
blade --debug "测试连接"

# 4. 直接指定密钥测试
blade --api-key your-key "测试"
```

**获取正确的 API 密钥：**
- [千问 API 密钥](https://dashscope.console.aliyun.com/apiKey)
- [火山引擎 API 密钥](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)

### Q: 如何更换模型？

**A:** 可以通过命令行参数指定：

```bash
# 使用千问模型
blade --provider qwen --model qwen-max "复杂问题"

# 使用火山引擎模型
blade --provider volcengine "你好"

# 设置回退模型
blade --fallback-model qwen-turbo "问题"
```

## 🔧 使用问题

### Q: 命令行参数 `-i`、`--stream` 等不存在？

**A:** 这些是过时的文档，Blade Code 的正确用法是：

```bash
# ✅ 正确用法
blade "你好，世界！"           # 单次问答
blade                         # 交互式模式
blade --print "问题"          # 打印模式
blade --continue              # 继续对话
blade --session-id "work" "问题" # 指定会话

# ❌ 错误用法（不存在的命令）
blade chat "你好"             # 没有 chat 子命令
blade -i                      # 没有 -i 参数
blade --stream "问题"         # 没有 --stream 参数
```

### Q: 如何进行多轮对话？

**A:** 使用会话功能：

```bash
# 指定会话ID创建会话
blade --session-id "work" "我叫张三，是前端工程师"

# 继续该会话
blade --session-id "work" "你还记得我的职业吗？"

# 继续最近的对话
blade --continue "昨天我们聊了什么？"

# 恢复特定对话
blade --resume conversation-id "继续之前的讨论"
```

### Q: 工具调用失败？

**A:** 检查以下几点：

1. **确保在正确的目录**
   ```bash
   # Git 工具需要在 Git 仓库中
   cd your-git-repo
   blade "查看git状态"
   ```

2. **检查文件权限**
   ```bash
   # 文件工具需要读写权限
   ls -la
   blade "读取 package.json"
   ```

3. **使用调试模式**
   ```bash
   blade --debug "分析代码"
   ```

## 🛡️ 安全问题

### Q: Blade Code 是否安全？

**A:** Blade Code 内置多重安全机制：

- **智能确认**：所有写入操作都需要用户确认
- **风险分级**：操作按风险等级分类（安全/中等/高风险/极高风险）
- **沙箱支持**：支持 Docker 沙箱模式（可选）
- **权限控制**：支持工具白名单和权限管理

### Q: 如何启用沙箱模式？

**A:** 沙箱模式需要 Docker 支持：

```bash
# 检查 Docker 是否可用
docker --version

# 启用沙箱模式（未来版本）
blade config set security.sandbox docker

# 当前版本使用确认机制
blade "删除文件"  # 会提示确认
```

## 🔄 技术问题

### Q: Node.js 版本要求？

**A:** Blade Code 要求：

- **最低版本**: Node.js 18.0+
- **推荐版本**: Node.js 20.0+

```bash
# 检查 Node.js 版本
node --version

# 升级 Node.js（使用 nvm）
nvm install 20
nvm use 20
```

### Q: 内存使用过高？

**A:** 优化方案：

```bash
# 使用打印模式减少UI开销
blade --print "问题"

# 限制上下文长度
blade --max-tokens 1000 "问题"

# 清理缓存
rm -rf ~/.blade/cache
```

### Q: 网络连接问题？

**A:** 网络问题解决方案：

```bash
# 使用国内镜像安装
npm install -g blade-code --registry=https://registry.npmmirror.com

# 检查网络连接
ping dashscope.aliyuncs.com

# 使用代理
export http_proxy=http://your-proxy:port
export https_proxy=http://your-proxy:port
```

## 📱 IDE 集成

### Q: 如何在 VS Code 中使用？

**A:** Blade Code 支持多种 IDE 集成：

```bash
# 检查 IDE 支持
blade doctor

# 自动安装扩展
blade ide install

# 手动配置 VS Code
# 添加到 settings.json:
{
  "terminal.integrated.profiles.osx": {
    "Blade": {
      "path": "blade"
    }
  }
}
```

## 🔧 高级配置

### Q: 如何配置多个 API 密钥？

**A:** 配置多个提供商：

```bash
# 环境变量方式
export QWEN_API_KEY="your-qwen-key"
export VOLCENGINE_API_KEY="your-volcengine-key"

# 配置文件方式
mkdir -p ~/.blade
nano ~/.blade/config.json        # 例如 {"provider":"openai-compatible","apiKey":"your-qwen-key"}
mkdir -p .blade
nano .blade/config.json          # 为项目单独指定 {"provider":"volcengine","apiKey":"your-volcengine-key"}
```

### Q: 如何自定义系统提示？

**A:** 使用系统提示参数：

```bash
blade --append-system-prompt "你是专家" "请解答"

# 或在交互模式中设置
blade
# 然后输入自定义提示
```

## 📞 获取帮助

### 仍有问题？

1. **查看帮助信息**
   ```bash
   blade --help
   blade config --help
   blade mcp --help
   ```

2. **启用调试模式**
   ```bash
   blade --debug "你的问题"
   ```

3. **健康检查**
   ```bash
   blade doctor
   ```

4. **GitHub Issues**
   - [报告问题](https://github.com/echoVic/blade-code/issues)
   - [功能建议](https://github.com/echoVic/blade-code/issues)

5. **查看日志**
   ```bash
   # 查看错误日志
   cat ~/.blade/logs/error.log

   # 查看调试日志
   blade --debug --log-level verbose "问题"
   ```

---

希望这些解答能帮助你更好地使用 Blade Code！如果还有其他问题，请随时提出。🎉
