# MCP OAuth 生命周期

Blade 对远程 HTTP/SSE MCP 使用标准 OAuth 2.1 discovery、PKCE 和动态客户端注册。
连接、授权和凭证生命周期彼此分离：普通 Session 只能消费已有凭证，不能自行打开
浏览器或启动宿主回调服务。

## 配置

```json
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/rpc",
      "oauth": {
        "enabled": true,
        "scopes": ["mcp:tools"],
        "callbackPort": 7777
      }
    }
  }
}
```

`clientId` 可用于预注册 public client；省略时，Blade 按 RFC 7591 使用动态客户端
注册。`callbackPort` 可选，默认 `7777`，回调只监听 `127.0.0.1`。

Blade 不接受以下旧字段：

- `clientSecret`
- `authorizationUrl`
- `tokenUrl`
- `redirectUri`

授权服务器和 token endpoint 必须通过 RFC 9728 Protected Resource Metadata 与
RFC 8414/OIDC metadata discovery 获得。OAuth MCP URL 必须使用 HTTPS；仅
`127.0.0.1`、`[::1]` 或 `localhost` 允许 HTTP。URL credentials 和同时配置的
`Authorization` header 会被拒绝。

## 显式授权

CLI：

```bash
blade mcp login remote
blade mcp logout remote
```

TUI：

```text
/mcp login remote
/mcp logout remote
```

Web MCP 面板先启动后台 flow，再显示 `Continue authorization` 外链。浏览器刷新后，
面板从服务端恢复 `authorizing` 状态，并通过 `Resume authorization` 取回同一个
授权 URL。授权完成后 Registry 自动重连，面板显示 `Authorized`、连接状态和工具列表。

普通 `connect`、Session 启动、headless 和 ACP 不会隐式打开浏览器。ACP Session
同时禁止读取宿主 MCP OAuth 凭证；远程 IDE 提供相同 server 名称或 URL 也不能借用
本机用户 token。

## 凭证边界

凭证保存在：

```text
${BLADE_STORAGE_ROOT:-~/.blade}/mcp/oauth-credentials.json
```

账本特性：

- endpoint、client ID 和排序后的 scopes 共同形成 SHA-256 身份；
- 文件为严格 schema、当前用户所有、权限 `0600`；
- 目录不允许 group/other 访问；
- 写入使用原子替换，同进程 mutex 与跨进程排他锁防止 lost update；
- symlink、非普通文件、错误 owner/mode、超大或损坏账本统一 fail closed；
- access token、refresh token、动态 client information 和 discovery state 不进入
  MCP 配置、Web API、事件、日志或 Session transcript。

SDK transport 在服务器返回 `401` 后使用 refresh token 刷新并重放原请求。刷新失败
不会自动进入交互授权；用户必须从 CLI、TUI 或 Web 显式重新授权。

## 资格要求

确定性集成使用真实 OAuth authorization server 和真实 Streamable HTTP MCP，覆盖：

- 未授权连接零浏览器副作用；
- RFC 9728/8414 discovery、动态注册、state、PKCE 和 code exchange；
- token 到期后的 `401` refresh 与原调用重放；
- 新客户端从 0600 账本恢复、logout 后立即失效；
- endpoint/client/scopes 隔离和 ACP 宿主凭证拒绝；
- callback、MCP HTTP 进程和端口回收。

真实 GPT 必须通过 production Session 完成
`ToolSearch -> OAuth MCP tool -> Write`。生产 DeepSeek Web GUI 必须完成显式授权、
刷新恢复、自动重连、逐次工具审批、落盘 marker、fresh-tab 会话恢复，并保持 access /
refresh token 不出现在 trace 或浏览器事件中。
