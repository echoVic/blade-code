# 故障排查指南

本指南帮助你解决使用 Blade Code 时可能遇到的常见问题。

## 📋 目录

- [安装问题](#安装问题)
- [配置问题](#配置问题)
- [连接问题](#连接问题)
- [性能问题](#性能问题)
- [MCP 问题](#mcp-问题)
- [权限问题](#权限问题)
- [其他问题](#其他问题)

---

## 安装问题

### 问题：npm install 失败

**症状**：
```bash
npm install -g blade-code
# 报错：EACCES: permission denied
```

**解决方案**：

1. 使用 Bun（推荐）：
```bash
bun install -g blade-code
```

2. 使用 nvm 管理 Node 版本（避免权限问题）：
```bash
nvm install 20
nvm use 20
npm install -g blade-code
```

3. 使用 sudo（不推荐）：
```bash
sudo npm install -g blade-code
```

### 问题：命令未找到

**症状**：
```bash
blade
# zsh: command not found: blade
```

**解决方案**：

1. 检查全局安装路径：
```bash
npm config get prefix
# 或
bun pm bin -g
```

2. 添加到 PATH：
```bash
# ~/.zshrc 或 ~/.bashrc
export PATH="$PATH:$(npm config get prefix)/bin"
```

3. 重启终端或执行：
```bash
source ~/.zshrc
```

---

## 配置问题

### 问题：首次启动提示配置错误

**症状**：
```
配置验证失败:
  - 没有可用的模型配置
```

**解决方案**：

1. 运行初始化向导：
```bash
blade
# 按照提示配置 API Key 和模型
```

2. 手动创建配置文件 `~/.blade/config.json`：
```json
{
  "currentModelId": "model-1",
  "models": [
    {
      "id": "model-1",
      "name": "默认模型",
      "provider": "openai-compatible",
      "apiKey": "your-api-key",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4"
    }
  ]
}
```

### 问题：API Key 配置后仍然报错

**症状**：
```
Error: API Key 无效或未设置
```

**解决方案**：

1. 验证 API Key 格式：
```bash
blade /model list
# 检查当前模型配置
```

2. 测试 API 连接：
```bash
curl -H "Authorization: Bearer $YOUR_API_KEY" \
     $BASE_URL/models
```

3. 检查环境变量是否覆盖：
```bash
echo $OPENAI_API_KEY
# 如果设置了环境变量，会覆盖配置文件
```

4. 重新配置模型：
```bash
blade
# 输入 /model add
# 按照提示重新配置
```

### 问题：配置文件损坏

**症状**：
```
JSON parse error in config file
```

**解决方案**：

1. 备份并重置配置：
```bash
mv ~/.blade/config.json ~/.blade/config.json.backup
blade
# 重新初始化配置
```

2. 验证 JSON 格式：
```bash
cat ~/.blade/config.json | jq .
# 如果报错，说明 JSON 格式有问题
```

---

## 连接问题

### 问题：API 请求超时

**症状**：
```
Error: Request timeout after 30000ms
```

**解决方案**：

1. 增加超时时间（`~/.blade/config.json`）：
```json
{
  "timeout": 60000
}
```

2. 检查网络连接：
```bash
ping api.openai.com
curl -I https://api.openai.com
```

3. 配置代理（如果在中国大陆）：
```bash
export HTTP_PROXY=http://localhost:7890
export HTTPS_PROXY=http://localhost:7890
blade
```

4. 使用国内镜像（如果可用）：
```json
{
  "models": [{
    "baseUrl": "https://your-proxy.com/v1"
  }]
}
```

### 问题：SSL 证书验证失败

**症状**：
```
Error: unable to verify the first certificate
```

**解决方案**（仅用于开发环境）：

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
blade
```

⚠️ **警告**：生产环境不要禁用 SSL 验证！

---

## 性能问题

### 问题：响应速度慢

**原因分析**：

1. **网络延迟高**：检查到 API 服务器的延迟
2. **上下文过大**：发送的 token 数量过多
3. **模型处理慢**：所选模型本身速度较慢

**解决方案**：

1. 启用流式响应（默认已启用）：
```json
{
  "stream": true
}
```

2. 减少上下文大小：
```bash
blade --max-turns 5
```

3. 使用更快的模型：
```bash
blade --model faster-model-id
```

4. 清理会话历史：
```bash
# 在 Blade 中
/clear
```

### 问题：内存占用过高

**症状**：
```
FATAL ERROR: Reached heap limit
```

**解决方案**：

1. 增加 Node.js 内存限制：
```bash
export NODE_OPTIONS="--max-old-space-size=4096"
blade
```

2. 清理会话缓存：
```bash
rm -rf ~/.blade/sessions/*
```

3. 禁用自动保存会话：
```json
{
  "autoSaveSessions": false
}
```

---

## MCP 问题

### 问题：MCP 服务器连接失败

**症状**：
```
[MCP] Failed to connect to server: connection refused
```

**解决方案**：

1. 检查服务器配置（`~/.blade/config.json`）：
```json
{
  "mcpEnabled": true,
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/server.js"]
    }
  }
}
```

2. 测试服务器独立运行：
```bash
node path/to/server.js
```

3. 查看详细日志：
```bash
blade --debug mcp
```

### 问题：MCP 工具未显示

**原因**：服务器未正确注册工具

**解决方案**：

1. 检查服务器健康状态：
```bash
blade
# 输入 /mcp status
```

2. 重启 MCP 服务器：
```bash
blade
# 输入 /mcp restart my-server
```

3. 验证工具列表：
```bash
blade
# 输入 /tools
# 应该能看到 MCP 工具（前缀 mcp__）
```

---

## 权限问题

### 问题：工具执行被拒绝

**症状**：
```
Permission denied: tool "Bash" is not allowed
```

**解决方案**：

1. 检查权限模式：
```bash
blade
# 输入 /permissions status
```

2. 允许特定工具：
```bash
blade
# 输入 /permissions allow Bash
```

3. 使用 YOLO 模式（危险）：
```bash
blade --yolo
```

### 问题：文件访问被拒绝

**症状**：
```
Path security violation: access denied
```

**解决方案**：

1. 在项目根目录运行 Blade：
```bash
cd /path/to/your/project
blade
```

2. 添加额外允许的目录：
```bash
blade --add-dir /path/to/other/dir
```

3. 检查 `.blade/settings.json` 配置：
```json
{
  "permissions": {
    "allow": ["Read", "Write"],
    "deny": []
  }
}
```

---

## 其他问题

### 问题：Ink UI 渲染异常

**症状**：终端界面显示乱码或重叠

**解决方案**：

1. 更新终端：使用现代终端（iTerm2、Warp、Windows Terminal）

2. 检查终端尺寸：
```bash
echo $COLUMNS x $LINES
# 确保终端足够大（至少 80x24）
```

3. 使用 Headless 模式：
```bash
blade --headless
```

### 问题：会话恢复失败

**症状**：
```
Error: Session not found
```

**解决方案**：

1. 列出所有会话：
```bash
blade
# 输入 /sessions
```

2. 手动指定会话 ID：
```bash
blade --session-id abc123
```

3. 检查会话文件：
```bash
ls ~/.blade/sessions/
```

### 问题：Hooks 不执行

**症状**：配置的 Hooks 没有触发

**解决方案**：

1. 检查 Hooks 配置（`.blade/settings.json`）：
```json
{
  "hooks": {
    "beforeChat": {
      "enabled": true,
      "command": "echo 'Before chat'"
    }
  },
  "disableAllHooks": false
}
```

2. 测试 Hooks 命令：
```bash
echo 'Before chat'
# 确保命令本身可以执行
```

3. 查看 Hooks 日志：
```bash
blade --debug hooks
```

---

## 🆘 获取帮助

如果以上方法都无法解决你的问题：

1. **查看详细日志**：
```bash
blade --debug
# 或指定类别
blade --debug agent,tools
```

2. **检查系统信息**：
```bash
blade --version
node --version
bun --version
```

3. **搜索已知问题**：
   - [GitHub Issues](https://github.com/echoVic/blade-code/issues)
   - [常见问题 FAQ](./faq.md)

4. **提交新 Issue**：
   - 包含完整的错误信息
   - 提供复现步骤
   - 附上系统信息和配置（隐藏敏感信息）

5. **加入社区**：
   - Discord / Slack（如有）
   - GitHub Discussions

---

## 📚 相关文档

- [快速开始](./getting-started/quick-start.md)
- [配置系统](./configuration/config-system.md)
- [权限管理](./configuration/permissions.md)
- [常见问题 FAQ](./faq.md)
