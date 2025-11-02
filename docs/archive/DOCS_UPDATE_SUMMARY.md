# 文档更新总结 - 移除过期的命令行参数和命令

## 📋 概述

已清理所有文档中过期的内容：
1. **命令行参数**：`--api-key`、`--base-url`、`--provider`
2. **命令**：`blade setup-token`

这些功能在旧版本中存在，但当前版本已经改用更好的配置方式。

## ✅ 已更新的文件

### 主要文档
1. **README.md** - 更新了"方式三：命令行参数"改为"方式三：配置命令"，移除了 `setup-token` 命令引用
2. **README.en.md** - 同步更新英文版，移除了 `setup-token` 命令引用
3. **docs/public/faq.md** - 更新了 API 配置和模型切换示例
4. **docs/public/getting-started/installation.md** - 更新了方式4的配置示例，移除了 `setup-token` 引用
5. **docs/public/getting-started/quick-start.md** - 更新了方式3的配置示例
6. **docs/public/reference/cli-commands.md** - 移除了 `setup-token` 命令条目

### 归档/规划文档
7. **docs/archive/security-audits/configuration.md** - 标记为已废弃
8. **docs/contributing/security-policy.md** - 标记为已废弃
9. **docs/development/planning/agent-config-refactor-proposal-v2.md** - 标记 `setupToken.ts` 为已删除

### 代码文件
10. **src/commands/setupToken.ts** - 已删除
11. **src/blade.tsx** - 移除了 `setupTokenCommands` 的导入和注册
12. **src/cli/types.ts** - 移除了 `SetupTokenOptions` 接口

## 🔄 变更对比

### 旧方式（已废弃）
```bash
# ❌ 不再支持的命令行参数
blade --api-key your-api-key --base-url https://api.example.com "你好"
blade --provider volcengine --api-key your-key "复杂问题"

# ❌ 不再支持的命令
blade setup-token --token sk-xxx
```

### 新方式（推荐）
```bash
# ✅ 方式1: 配置文件（推荐）
mkdir -p ~/.blade
cat > ~/.blade/config.json << 'EOF'
{
  "provider": "openai-compatible",
  "apiKey": "your-api-key",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-max"
}
EOF

# 或在配置文件中使用环境变量插值
cat > ~/.blade/config.json << 'EOF'
{
  "apiKey": "${BLADE_API_KEY}",
  "baseUrl": "${BLADE_BASE_URL:-https://apis.iflow.cn/v1}"
}
EOF

# ✅ 方式2: 首次启动设置向导（最友好）
blade
# 若未配置 API Key，将自动引导完成配置

# ✅ 方式3: 配置命令（最便捷）
blade config
```

## 📝 配置文件示例

### ~/.blade/config.json 或 .blade/config.json
```json
{
  "provider": "openai-compatible",
  "apiKey": "your-api-key",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-max",
  "temperature": 0.7
}
```

## 🎯 当前支持的命令

根据 `blade --help` 输出，当前实际支持的命令：

### 主要命令
- `blade [message..]` - 启动交互式界面或发送消息
- `blade config` - 配置管理
- `blade mcp` - 管理 MCP 服务器
- `blade doctor` - 系统健康检查
- `blade update` - 检查更新
- `blade install [target]` - 安装指定版本
- `blade completion` - 生成 shell 补全脚本

### 主要命令行参数

#### AI 选项
- `--model` - 指定模型
- `--fallback-model` - 备用模型
- `--system-prompt` - 系统提示
- `--append-system-prompt` - 追加系统提示
- `--max-turns` - 最大对话轮次
- `--agents` - 自定义 Agent 配置

#### 配置选项
- `--settings` - 设置文件路径
- `--setting-sources` - 配置来源

#### 其他选项
- `--debug` - 调试模式
- `--print` - 打印模式
- `--continue` - 继续会话
- `--resume` - 恢复会话
- `--permission-mode` / `--yolo` - 权限模式
- 等等...

## ⚠️ 注意事项

1. **不要添加** `--api-key`、`--base-url`、`--provider` 参数到 CLI 配置
2. **不要重新实现** `setup-token` 命令
3. 这些功能已经通过更安全的方式支持（环境变量、配置文件、设置向导）
4. 文档中提到的这些参数都已更新为正确的配置方式

## 📌 待处理

- `docs/development/architecture/agent.md` 中有 `--provider` 的引用，但这是架构设计文档，描述的是 `agent-llm` 子命令（可能已废弃），暂不修改

## ✅ 验证结果

```bash
# 构建成功
$ bun run build
Bundled 1387 modules in 335ms
  blade.js  6.75 MB  (entry point)

# setup-token 命令已成功移除
$ node dist/blade.js --help | grep setup-token
(无输出)

# 当前可用命令
$ node dist/blade.js --help | grep "blade "
  blade [message..]      Start interactive AI assistant
  blade config           Manage configuration
  blade mcp              管理 MCP 服务器
  blade doctor           Check the health of your Blade installation
  blade update           Check for updates and install if available
  blade install [target] Install Blade native build
  blade completion       Generate completion script for bash/zsh
```

## ✨ 总结

所有用户面向的文档和代码都已更新，移除了对不存在的命令行参数和命令的引用，并提供了正确的配置方法。用户现在可以：

1. 使用配置文件（最推荐、最灵活）- 直接编辑或使用环境变量插值
2. 使用首次启动设置向导（最友好）
3. 使用 `blade config` 命令（最便捷）

这些方式都比命令行参数更安全、更易管理，且 `setup-token` 命令的功能已经被设置向导和配置命令完全替代。

**重要说明**：Blade 不直接读取环境变量（如 `QWEN_API_KEY`），而是通过配置文件中的环境变量插值来使用它们，例如：
```json
{
  "apiKey": "${BLADE_API_KEY}",
  "baseUrl": "${BLADE_BASE_URL:-https://apis.iflow.cn/v1}"
}
```
