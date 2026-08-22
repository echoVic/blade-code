# MCP OAuth Lifecycle

Blade uses standard OAuth 2.1 discovery, PKCE, and dynamic client registration for remote HTTP/SSE MCP. Connection, authorization, and credential lifecycles are separated from each other: ordinary Sessions can only consume existing credentials and cannot open browsers or start host callback services on their own.

## Configuration

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

`clientId` can be used for pre-registered public clients; when omitted, Blade uses dynamic client registration per RFC 7591. `callbackPort` is optional, defaulting to `7777`; the callback listens only on `127.0.0.1`.

Blade does not accept the following legacy fields:

- `clientSecret`
- `authorizationUrl`
- `tokenUrl`
- `redirectUri`

Authorization server and token endpoints must be obtained via RFC 9728 Protected Resource Metadata and RFC 8414/OIDC metadata discovery. OAuth MCP URLs must use HTTPS; HTTP is permitted only for `127.0.0.1`, `[::1]`, or `localhost`. URL credentials and concurrently configured `Authorization` headers are rejected.

## Explicit Authorization

CLI:

```bash
blade mcp login remote
blade mcp logout remote
```

TUI:

```text
/mcp login remote
/mcp logout remote
```

The Web MCP panel first starts a background flow, then displays an external `Continue authorization` link. After a browser refresh, the panel restores the `authorizing` state from the server and retrieves the same authorization URL via `Resume authorization`. After authorization completes, the Registry automatically reconnects, and the panel displays `Authorized`, connection status, and tool list.

Ordinary `connect`, Session startup, headless, and ACP do not implicitly open browsers. ACP Sessions are also prohibited from reading host MCP OAuth credentials; remote IDEs providing the same server name or URL cannot borrow local user tokens.

## Credential Boundary

Credentials are stored at:

```text
${BLADE_STORAGE_ROOT:-~/.blade}/mcp/oauth-credentials.json
```

Ledger properties:

- endpoint, client ID, and sorted scopes together form a SHA-256 identity;
- The file follows a strict schema, is owned by the current user, and has `0600` permissions;
- The directory does not allow group/other access;
- Writes use atomic replacement, with same-process mutex and cross-process exclusive locks preventing lost updates;
- Symlinks, non-regular files, incorrect owner/mode, oversized, or corrupted ledgers uniformly fail closed;
- Access tokens, refresh tokens, dynamic client information, and discovery state do not enter MCP configuration, Web API, events, logs, or Session transcripts.

After the server returns `401`, the SDK transport refreshes using the refresh token and replays the original request. Refresh failure does not automatically enter interactive authorization; the user must explicitly re-authorize from CLI, TUI, or Web.

## Qualification Requirements

Deterministic integration uses real OAuth authorization servers and real Streamable HTTP MCP, covering:

- Unauthorized connections have zero browser side effects;
- RFC 9728/8414 discovery, dynamic registration, state, PKCE, and code exchange;
- `401` refresh after token expiry and original call replay;
- New clients recover from the 0600 ledger and immediately become invalid after logout;
- endpoint/client/scopes isolation and ACP host credential rejection;
- Callback, MCP HTTP process, and port reclamation.

Real GPT must complete `ToolSearch -> OAuth MCP tool -> Write` via a production Session. Production DeepSeek Web GUI must complete explicit authorization, refresh recovery, automatic reconnection, per-call tool approval, on-disk markers, fresh-tab session restoration, and keep access/refresh tokens from appearing in traces or browser events.
