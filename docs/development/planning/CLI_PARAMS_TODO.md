# CLI 参数实现状态

本文档记录已在 CLI 中定义的命令行参数的实现状态。

## ✅ 已完全实现

### `--mcp-config` / `--strict-mcp-config`

**实现日期**: 2025-11-02

**实现位置**:
- [src/mcp/loadProjectMcpConfig.ts](../../../src/mcp/loadProjectMcpConfig.ts) - 核心加载逻辑
- [src/agent/types.ts:43-45](../../../src/agent/types.ts#L43-L45) - AgentOptions 接口
- [src/agent/Agent.ts:1277-1278](../../../src/agent/Agent.ts#L1277-L1278) - Agent 调用

**功能说明**:
- `--mcp-config`: 从指定的 JSON 文件或字符串加载 MCP 服务器配置（支持多个）
- `--strict-mcp-config`: 仅使用通过 `--mcp-config` 指定的服务器，忽略项目级 `.mcp.json`

**用法示例**:
```bash
# 加载指定的 MCP 配置文件
blade --mcp-config ./custom-mcp.json

# 使用 JSON 字符串
blade --mcp-config '{"myserver":{"type":"stdio","command":"node","args":["server.js"]}}'

# 加载多个配置
blade --mcp-config server1.json --mcp-config server2.json

# 严格模式：只使用指定的配置，忽略 .mcp.json
blade --mcp-config my.json --strict-mcp-config
```

**实现特性**:
- ✅ 支持文件路径（绝对路径和相对路径）
- ✅ 支持JSON字符串直接传入
- ✅ 支持多个配置源（`--mcp-config` 可以多次使用）
- ✅ CLI参数来源的配置直接加载，无需用户确认
- ✅ 严格模式下跳过项目级 `.mcp.json`
- ✅ 配置加载优先级：CLI参数 > 项目级 .mcp.json

---

## 🚧 待实现的参数

### 1. `--settings` / `--settingSources`

**定义位置**: [src/cli/config.ts:148-152](src/cli/config.ts#L148-L152), [src/cli/config.ts:184-188](src/cli/config.ts#L184-L188)

**当前状态**: ❌ 未实现

**预期功能**:
- `--settings`: 允许用户通过命令行指定配置文件路径或直接传入 JSON 字符串
- `--setting-sources`: 指定配置来源优先级（如 `global,user,local`）

**实现要点**:
```typescript
// 需要在以下位置实现:
// 1. src/config/ConfigManager.ts - 读取并解析 settings 参数
// 2. src/ui/App.tsx 或 src/blade.tsx - 传递给配置系统
```

**用法示例**:
```bash
# 使用配置文件
blade --settings /path/to/settings.json

# 使用 JSON 字符串
blade --settings '{"theme":"dark","model":"qwen-max"}'

# 指定配置来源
blade --setting-sources "local,user"
```

---

### 2. `--ide`

**定义位置**: [src/cli/config.ts:161-165](src/cli/config.ts#L161-L165)

**当前状态**: ❌ 未实现

**预期功能**:
- 启动时自动连接到 IDE（如 VSCode、Cursor 等）
- IDE 相关代码已存在于 `src/ide/` 目录，但未与 CLI 参数关联

**实现要点**:
```typescript
// 需要在以下位置实现:
// 1. src/blade.tsx - 检查 argv.ide 参数
// 2. src/ui/App.tsx - 启动时调用 IDE 连接逻辑
// 3. src/ide/ideInstaller.ts - 确保自动连接功能完整
```

**用法示例**:
```bash
# 启动并自动连接 IDE
blade --ide

# 与其他参数组合
blade --ide --debug
```

---

### 3. `--agents`

**定义位置**: [src/cli/config.ts:179-183](src/cli/config.ts#L179-L183)

**当前状态**: ❌ 未实现

**预期功能**:
- 通过 JSON 对象定义自定义 Agent 配置
- 允许覆盖默认 Agent 设置（如模型、温度等）

**实现要点**:
```typescript
// 需要在以下位置实现:
// 1. src/blade.tsx - 解析 argv.agents JSON 字符串
// 2. src/agent/ - 使用自定义配置初始化 Agent
// 3. 验证 JSON 格式并提供错误处理
```

**用法示例**:
```bash
# 自定义 Agent 配置
blade --agents '{"reviewer":{"model":"qwen-max","temperature":0.3}}'

# 定义多个 Agent
blade --agents '{"coder":{"model":"qwen-coder"},"reviewer":{"model":"qwen-max"}}'
```

---

## 📋 实现优先级建议

### P0 (高优先级)
- ~~**`--mcp-config` / `--strict-mcp-config`**~~: ✅ 已完成 (2025-11-02)
- **`--settings`**: 与配置系统直接相关，用户需求高

### P1 (中优先级)
- **`--agents`**: Agent 自定义配置，对高级用户有价值

### P2 (低优先级)
- **`--ide`**: IDE 集成功能，代码已存在但使用场景有限
- **`--setting-sources`**: 配置高级功能，多数用户不需要

---

### 4. `--mcp-config` / `--strict-mcp-config`

**定义位置**: [src/cli/config.ts:69-74](src/cli/config.ts#L69-L74), [src/cli/config.ts:166-170](src/cli/config.ts#L166-L170)

**当前状态**: ⚠️ 部分实现

**已有功能**:
- ✅ MCP 系统已完整实现（`src/mcp/` 目录）
- ✅ 支持从项目级 `.mcp.json` 文件加载配置
- ✅ `blade mcp` 命令用于管理 MCP 服务器

**缺失功能**:
- ❌ CLI 参数 `--mcp-config` 未连接到 MCP 加载系统
- ❌ CLI 参数 `--strict-mcp-config` 未实现

**预期功能**:
- `--mcp-config`: 从指定的 JSON 文件或字符串加载 MCP 服务器配置（支持多个）
- `--strict-mcp-config`: 仅使用通过 `--mcp-config` 指定的服务器，忽略项目级 `.mcp.json`

**实现要点**:
```typescript
// 需要在以下位置实现:
// 1. src/mcp/loadProjectMcpConfig.ts - 添加从 CLI 参数加载的逻辑
// 2. src/blade.tsx 或 src/ui/App.tsx - 在启动时检查 argv.mcpConfig
// 3. 支持以下格式:
//    - 文件路径: --mcp-config /path/to/mcp.json
//    - JSON 字符串: --mcp-config '{"server1":{...}}'
//    - 多个配置: --mcp-config file1.json --mcp-config file2.json
```

**用法示例**:
```bash
# 加载指定的 MCP 配置文件
blade --mcp-config ./custom-mcp.json

# 使用 JSON 字符串
blade --mcp-config '{"myserver":{"type":"stdio","command":"node","args":["server.js"]}}'

# 加载多个配置
blade --mcp-config server1.json --mcp-config server2.json

# 严格模式：只使用指定的配置，忽略 .mcp.json
blade --mcp-config my.json --strict-mcp-config
```

**与现有实现的集成**:
当前 MCP 系统通过 `loadProjectMcpConfig()` 自动加载项目根目录的 `.mcp.json`。
需要扩展此逻辑以支持：
1. 优先加载 `--mcp-config` 指定的配置
2. 如果设置了 `--strict-mcp-config`，跳过自动加载 `.mcp.json`
3. 合并多个配置源（除非 strict 模式）

---

## ✅ 已验证的实现参数

以下参数已确认实现并正常工作：

- `--debug` - 调试模式 ✓
- `--print` - 打印模式 ✓
- `--output-format` - 输出格式 ✓
- `--include-partial-messages` - 部分消息 ✓
- `--input-format` - 输入格式 ✓
- `--replay-user-messages` - 重放用户消息 ✓
- `--allowed-tools` / `--disallowed-tools` - 工具白/黑名单 ✓
- `--permission-mode` / `--yolo` - 权限模式 ✓
- `--add-dir` - 额外目录访问 ✓
- `--mcp-config` / `--strict-mcp-config` - MCP 配置 ✓
- `--system-prompt` / `--append-system-prompt` - 系统提示 ✓
- `--max-turns` - 最大对话轮次 ✓
- `--model` / `--fallback-model` - 模型配置 ✓
- `--continue` / `--resume` - 会话管理 ✓
- `--fork-session` / `--session-id` - 会话 ID ✓

---

## 📝 注意事项

1. **向后兼容**: 实现这些参数时，需要确保不破坏现有配置文件系统
2. **文档同步**: 实现后需要更新 README.md 和 docs/ 中的相关文档
3. **测试覆盖**: 添加单元测试和集成测试
4. **错误处理**: 提供清晰的错误信息和使用示例

---

**最后更新**: 2025-11-02
**维护者**: echoVic
