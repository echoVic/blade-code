# 🔗 MCP (Model Context Protocol) 实现文档

> **状态**: ✅ 已实现（客户端）
> **协议版本**: 2024-11-05
> **实现位置**: [src/mcp/](../../../src/mcp/)

## 📋 概述

Blade 实现了完整的 MCP (Model Context Protocol) 客户端支持，允许连接到外部 MCP 服务器以扩展工具能力。

### 🎯 核心功能

- ✅ **MCP 客户端**：连接到外部 MCP 服务器（stdio 传输）
- ✅ **工具发现**：自动发现和注册 MCP 服务器提供的工具
- ✅ **工具调用**：通过统一的工具接口调用 MCP 工具
- ✅ **配置管理**：服务器配置持久化和管理
- ✅ **OAuth 支持**：GitHub 和 Google OAuth 集成
- ⚠️ **MCP 服务器**：Blade 作为 MCP 服务器（待实现）

## 🏗️ 架构设计

### 目录结构

```
src/mcp/
├── McpClient.ts              # MCP 客户端实现（stdio 传输）
├── McpRegistry.ts            # MCP 服务器注册表和管理
├── McpToolInvocation.ts      # MCP 工具调用适配器
├── createMcpTool.ts          # MCP 工具创建工厂
├── types.ts                  # MCP 类型定义
├── config/
│   └── MCPConfig.ts          # MCP 配置管理器
├── OAuthProvider.ts          # OAuth 认证提供商
└── oauthTokenStorage.ts      # OAuth 令牌存储
```

### 核心组件

#### 1. McpClient

负责与 MCP 服务器通信：

```typescript
// src/mcp/McpClient.ts
export class McpClient extends EventEmitter {
  async connect(): Promise<void>;           // 连接服务器
  async disconnect(): Promise<void>;        // 断开连接
  async listTools(): Promise<Tool[]>;       // 列出工具
  async callTool(name, args): Promise<any>; // 调用工具
}
```

**传输方式**：
- ✅ Stdio（标准输入输出）
- ⚠️ SSE（Server-Sent Events）- 待实现
- ⚠️ WebSocket - 待实现

#### 2. McpRegistry

管理多个 MCP 服务器连接：

```typescript
// src/mcp/McpRegistry.ts
export class McpRegistry extends EventEmitter {
  async registerServer(config: McpServerConfig): Promise<void>;
  async unregisterServer(name: string): Promise<void>;
  async connectServer(name: string): Promise<void>;
  async disconnectServer(name: string): Promise<void>;
  async discoverTools(): Promise<Tool[]>;
  getAllServers(): Map<string, McpServerInfo>;
}
```

**服务器状态**：
- `DISCONNECTED` - 未连接
- `CONNECTING` - 连接中
- `CONNECTED` - 已连接
- `ERROR` - 错误状态

#### 3. 工具集成

MCP 工具通过 `createMcpTool` 转换为 Blade 标准工具：

```typescript
// src/mcp/createMcpTool.ts
export function createMcpTool(
  mcpTool: McpToolDefinition,
  client: McpClient,
  serverName: string
): Tool
```

转换后的工具：
- 统一的工具接口（`Tool` 类型）
- Zod Schema 参数验证
- 标准化的结果格式
- 权限检查集成

## 🚀 使用指南

### 1. 添加 MCP 服务器

#### 方式 1: 使用 JSON 配置字符串

```bash
blade mcp add my-server '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]}'
```

#### 方式 2: 使用配置文件

创建 `mcp-config.json`：

```json
{
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/Users/username/Documents"
  ],
  "env": {
    "NODE_ENV": "production"
  },
  "timeout": 30000,
  "autoRestart": true
}
```

添加服务器：

```bash
blade mcp add my-server mcp-config.json
```

#### 配置项说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | 服务器启动命令 |
| `args` | string[] | ❌ | 命令参数 |
| `env` | object | ❌ | 环境变量 |
| `timeout` | number | ❌ | 超时时间（毫秒，默认 30000） |
| `autoRestart` | boolean | ❌ | 自动重启（默认 false） |

### 2. 管理 MCP 服务器

#### 列出所有服务器

```bash
blade mcp list
# 或简写
blade mcp ls
```

输出示例：

```
┌─────────────┬───────────┬──────────────────────────┬─────────────────────┐
│ name        │ status    │ command                  │ connectedAt         │
├─────────────┼───────────┼──────────────────────────┼─────────────────────┤
│ filesystem  │ connected │ npx                      │ 2025-10-13T12:34:56 │
│ github      │ disconnec │ mcp-server-github        │ never               │
└─────────────┴───────────┴──────────────────────────┴─────────────────────┘
```

#### 启动/停止服务器

```bash
# 启动服务器
blade mcp start my-server

# 停止服务器
blade mcp stop my-server
```

#### 删除服务器

```bash
blade mcp remove my-server
# 或简写
blade mcp rm my-server
```

### 3. 配置文件位置

MCP 配置存储在：

```
~/.blade/mcp-config.json
```

配置文件结构：

```json
{
  "enabled": true,
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem Server",
      "endpoint": "",
      "transport": "stdio",
      "enabled": true,
      "config": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
      },
      "capabilities": ["tools"],
      "autoConnect": false
    }
  ],
  "autoConnect": false,
  "timeout": 30000,
  "maxConnections": 10,
  "defaultTransport": "stdio",
  "security": {
    "validateCertificates": true,
    "allowedOrigins": ["localhost"],
    "maxMessageSize": 1048576
  },
  "logging": {
    "enabled": true,
    "level": "info",
    "filePath": "~/.blade/mcp.log"
  },
  "caching": {
    "enabled": true,
    "ttl": 300,
    "maxSize": 1000
  }
}
```

## 🔧 开发者指南

### 工具调用流程

```
1. Agent 请求工具调用
     ↓
2. ToolRegistry 查找工具（mcp__{serverName}__{toolName}）
     ↓
3. McpToolInvocation 执行
     ↓
4. McpClient 通过 stdio 发送 JSON-RPC 请求
     ↓
5. MCP 服务器处理并返回结果
     ↓
6. McpClient 解析响应
     ↓
7. 结果格式化为标准 ToolResult
     ↓
8. 返回给 Agent
```

### 工具命名规范

MCP 工具在 Blade 中的命名格式：

```
mcp__{serverName}__{toolName}
```

例如：
- `mcp__filesystem__read_file`
- `mcp__github__create_issue`

### 添加新的传输方式

当前只实现了 stdio，要添加 SSE 或 WebSocket：

1. 在 `McpClient.ts` 中添加新的传输实现
2. 更新 `McpServerConfig` 类型支持新传输配置
3. 在 `connect()` 方法中添加传输选择逻辑

### OAuth 集成

支持 GitHub 和 Google OAuth：

```typescript
import { GitHubOAuthProvider, GoogleOAuthProvider } from '../mcp';

// GitHub OAuth
const github = new GitHubOAuthProvider({
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  redirectUri: 'http://localhost:3000/callback'
});

const token = await github.getAccessToken(authCode);
```

## 🧪 测试

### 测试 MCP 连接

```bash
# 使用官方文件系统服务器测试
blade mcp add test-fs '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}'
blade mcp start test-fs
blade mcp list
```

### 验证工具发现

在 Agent 中检查 MCP 工具：

```typescript
import { ToolRegistry } from './tools';

const registry = ToolRegistry.getInstance();
const tools = registry.getAllTools();

// 查找 MCP 工具（名称包含 mcp__ 前缀）
const mcpTools = tools.filter(t => t.name.startsWith('mcp__'));
console.log('MCP Tools:', mcpTools.map(t => t.name));
```

## 📊 性能考虑

### 连接池

McpRegistry 管理连接池：
- 最大连接数：10（可配置）
- 自动重连机制
- 超时控制：30秒（可配置）

### 缓存

工具定义缓存：
- TTL：5分钟（可配置）
- 最大缓存数：1000（可配置）
- 自动失效机制

### 资源管理

- stdio 进程自动清理
- 连接断开时释放资源
- 错误重试机制（最多 3 次）

## 🔍 调试

### 启用详细日志

```bash
export BLADE_DEBUG=1
blade mcp start my-server
```

日志位置：`~/.blade/mcp.log`

### 常见问题

**问题 1: 服务器无法启动**

```bash
# 检查命令是否可执行
which npx

# 检查服务器包是否安装
npm list -g @modelcontextprotocol/server-filesystem
```

**问题 2: 工具调用失败**

```bash
# 检查服务器状态
blade mcp list

# 查看日志
tail -f ~/.blade/mcp.log
```

**问题 3: 权限被拒绝**

检查 settings.json 中的权限配置：

```json
{
  "tools": {
    "permissions": {
      "allow": ["mcp__*"],  // 允许所有 MCP 工具
      "ask": [],
      "deny": []
    }
  }
}
```

## 🔗 相关资源

- **MCP 协议规范**: [https://spec.modelcontextprotocol.io](https://spec.modelcontextprotocol.io)
- **官方 MCP 服务器**: [https://github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
- **Blade 工具系统**: [tools.md](tools.md)
- **权限系统**: [../../public/configuration/permissions.md](../../public/configuration/permissions.md)

## 🚧 待实现功能

- [ ] Blade 作为 MCP 服务器（暴露 Blade 工具给其他应用）
- [ ] SSE 传输支持
- [ ] WebSocket 传输支持
- [ ] 资源订阅（Resource subscription）
- [ ] 提示模板同步（Prompt templates）
- [ ] 服务器健康检查
- [ ] 自动故障转移
- [ ] 性能监控和指标

---

**最后更新**: 2025-10-13
**维护者**: Blade Team
