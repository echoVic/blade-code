# MCP Implementation Improvements

## Overview

This document records the improvements made to the MCP (Model Context Protocol) implementation in Blade, migrating from custom transport implementations to the official `@modelcontextprotocol/sdk` and adding enterprise-grade reliability features.

## Phase 1: Migration to Official SDK

### Changes Made

1. **Replaced Custom Transports with Official SDK**
   - Deleted custom implementations:
     - `src/mcp/transports/StdioTransport.ts` (191 lines)
     - `src/mcp/transports/SSETransport.ts` (166 lines)
     - `src/mcp/transports/HttpTransport.ts` (107 lines)
   - Now using SDK-provided transports:
     - `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`
     - `SSEClientTransport` from `@modelcontextprotocol/sdk/client/sse.js`
     - `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`

2. **Simplified Transport Layer**
   - `src/mcp/transports/types.ts`: Reduced from 50 lines to 7 lines
   - Now only exports SDK's `Transport` type
   - Removed custom transport abstractions

3. **Updated McpClient**
   - Complete rewrite using official SDK `Client` class
   - Uses dynamic version info via `getPackageName()` and `getVersion()` from `src/utils/packageInfo.ts`
   - Integrated SDK's built-in JSON-RPC handling
   - Added SDK capabilities configuration (roots, sampling)

4. **Removed Redundant Configuration**
   - Deleted `src/mcp/config/MCPConfig.ts` (325 lines)
   - Unified configuration management through global `ConfigManager`
   - Removed duplicate `McpConfigManager` that was unused

5. **Updated Type Definitions**
   - Changed transport types from `websocket` to `http` in `src/mcp/types.ts`
   - Updated validation logic to accept `http` transport type

### Benefits

- **Reduced maintenance burden**: 789 lines removed (464 transport + 325 config)
- **Automatic protocol updates**: SDK handles MCP protocol changes
- **Better reliability**: SDK's battle-tested transport implementations
- **Cleaner codebase**: Unified configuration through global ConfigManager
- **Correct transport types**: Updated to match SDK's supported transports

### Code Example

```typescript
// Before: Custom Client instantiation
this.client = new CustomMcpClient(config);

// After: Official SDK Client
this.sdkClient = new Client(
  {
    name: getPackageName(),
    version: getVersion(),
  },
  {
    capabilities: {
      roots: { listChanged: true },
      sampling: {},
    },
  }
);
```

## Phase 2: Reliability Enhancements

### 1. Error Classification System

Added intelligent error categorization based on patterns from neovate-code:

```typescript
export enum ErrorType {
  NETWORK_TEMPORARY = 'network_temporary',  // Retryable
  NETWORK_PERMANENT = 'network_permanent',  // Not retryable
  CONFIG_ERROR = 'config_error',            // Not retryable
  AUTH_ERROR = 'auth_error',                // Not retryable
  PROTOCOL_ERROR = 'protocol_error',        // Not retryable
  UNKNOWN = 'unknown',                      // Retryable (conservative)
}
```

**Error Detection Patterns**:
- **Permanent errors**: `command not found`, `no such file`, `permission denied`, `invalid configuration`, `malformed`, `syntax error`
- **Auth errors**: `unauthorized`, `401`, `authentication failed`
- **Temporary errors**: `timeout`, `connection refused`, `network error`, `rate limit`, `503`, `429`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`

### 2. Retry Logic with Exponential Backoff

Implemented `connectWithRetry()` method:

```typescript
async connectWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.doConnect();
      this.reconnectAttempts = 0; // Reset counter on success
      return;
    } catch (error) {
      const classified = classifyError(error);

      // Don't retry permanent errors
      if (!classified.isRetryable) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.warn(`[McpClient] 连接失败（${attempt}/${maxRetries}），${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('连接失败');
}
```

**Features**:
- Default: 3 retries with delays of 1s, 2s, 4s
- Exponential backoff prevents overwhelming servers
- Skips retry on permanent errors (config, auth)
- Resets reconnect counter on successful connection

### 3. Automatic Reconnection

Implemented `scheduleReconnect()` for handling unexpected disconnections:

```typescript
private scheduleReconnect(): void {
  if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
    console.error('[McpClient] 达到最大重连次数，放弃重连');
    this.emit('reconnectFailed');
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s)
  const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
  this.reconnectAttempts++;

  this.reconnectTimer = setTimeout(async () => {
    try {
      await this.doConnect();
      console.log('[McpClient] 重连成功');
      this.reconnectAttempts = 0;
      this.emit('reconnected');
    } catch (error) {
      const classified = classifyError(error);
      if (classified.isRetryable) {
        this.scheduleReconnect(); // Continue trying
      } else {
        this.emit('reconnectFailed'); // Give up on permanent errors
      }
    }
  }, delay);
}
```

**Features**:
- Up to 5 reconnection attempts
- Exponential backoff with 30s maximum delay
- Monitors SDK's `onclose` event for unexpected disconnections
- Distinguishes manual vs unexpected disconnections
- Stops on permanent errors

### 4. Connection Lifecycle Management

Enhanced disconnect logic:

```typescript
async disconnect(): Promise<void> {
  this.isManualDisconnect = true;

  // Clear reconnection timer
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  if (this.sdkClient) {
    await this.sdkClient.close();
    this.sdkClient = null;
  }

  this.tools.clear();
  this.serverInfo = null;
  this.reconnectAttempts = 0;
  this.setStatus(McpConnectionStatus.DISCONNECTED);
  this.emit('disconnected');

  this.isManualDisconnect = false;
}
```

**Features**:
- Prevents auto-reconnect on manual disconnect
- Clears all timers and state
- Emits proper lifecycle events
- Safe cleanup prevents memory leaks

### 5. SDK Integration

Monitors SDK client lifecycle:

```typescript
this.sdkClient.onclose = () => {
  this.handleUnexpectedClose();
};

private handleUnexpectedClose(): void {
  if (this.isManualDisconnect) {
    return; // Expected disconnect
  }

  if (this.status === McpConnectionStatus.CONNECTED) {
    console.warn('[McpClient] 检测到意外断连，准备重连...');
    this.setStatus(McpConnectionStatus.ERROR);
    this.emit('error', new Error('MCP服务器连接意外关闭'));
    this.scheduleReconnect();
  }
}
```

### 5. OAuth Authentication Support

Added OAuth 2.0 authentication with PKCE for secure server connections.

**Components**:

1. **OAuthProvider** ([src/mcp/auth/OAuthProvider.ts](../src/mcp/auth/OAuthProvider.ts))
   - Implements OAuth 2.0 authorization code flow with PKCE
   - Handles browser-based authentication
   - Automatic token refresh
   - Local callback server (port 7777)

2. **OAuthTokenStorage** ([src/mcp/auth/OAuthTokenStorage.ts](../src/mcp/auth/OAuthTokenStorage.ts))
   - File-based token storage (~/.blade/mcp-oauth-tokens.json)
   - Secure file permissions (0o600)
   - Token expiration tracking
   - Automatic cleanup

3. **McpClient Integration** ([src/mcp/McpClient.ts](../src/mcp/McpClient.ts))
   - Automatic OAuth token injection for HTTP/SSE transports
   - Token refresh on expiration
   - Falls back to authentication if no valid token

**Configuration Example**:

```typescript
const config: McpServerConfig = {
  type: 'sse',
  url: 'https://mcp-server.example.com/sse',
  oauth: {
    enabled: true,
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret', // Optional for public clients
    authorizationUrl: 'https://auth.example.com/oauth/authorize',
    tokenUrl: 'https://auth.example.com/oauth/token',
    scopes: ['mcp:read', 'mcp:write'],
    redirectUri: 'http://localhost:7777/oauth/callback' // Optional
  }
};
```

**Features**:
- PKCE (Proof Key for Code Exchange) for enhanced security
- Automatic browser opening for authentication
- Token caching and automatic refresh
- Secure token storage with restricted file permissions
- State parameter for CSRF protection
- Support for both confidential and public clients

**Code Statistics**:
- OAuthProvider: ~360 lines
- OAuthTokenStorage: ~135 lines
- Type definitions: ~45 lines
- Total: ~540 lines

## Phase 3: Advanced Features

### 1. Health Monitoring System

Added proactive health monitoring to detect zombie connections and trigger automatic recovery.

**Components**:

- **HealthMonitor** ([src/mcp/HealthMonitor.ts](../src/mcp/HealthMonitor.ts))
  - Periodic health checks (default: 30s interval)
  - Configurable failure threshold (default: 3 consecutive failures)
  - Automatic reconnection on unhealthy status
  - Multiple health states: HEALTHY, DEGRADED, UNHEALTHY, CHECKING

**Configuration Example**:

```typescript
const config: McpServerConfig = {
  type: 'sse',
  url: 'https://mcp-server.example.com/sse',
  healthCheck: {
    enabled: true,
    interval: 30000,      // Check every 30s
    timeout: 10000,       // 10s timeout
    failureThreshold: 3   // Reconnect after 3 failures
  }
};
```

**Features**:
- Configurable check interval and timeout
- Graceful degradation (HEALTHY → DEGRADED → UNHEALTHY)
- Automatic reconnection trigger
- Event-driven status updates
- Manual health check support via `client.healthCheck.checkNow()`

**Code Statistics**:
- HealthMonitor: ~260 lines
- McpClient integration: ~25 lines
- Configuration: ~7 lines

### 2. Schema Validation

Enhanced JSON Schema validation with error recovery.

**Features**:
- JSON Schema to Zod conversion for runtime validation
- Graceful degradation on invalid schemas
- Falls back to `z.any()` if schema conversion fails
- Prevents tools from being unusable due to schema errors

**Implementation** ([src/mcp/createMcpTool.ts](../src/mcp/createMcpTool.ts)):

```typescript
try {
  zodSchema = convertJsonSchemaToZod(toolDef.inputSchema);
} catch (error) {
  console.warn(`Schema conversion failed, using fallback: ${toolDef.name}`);
  zodSchema = z.any(); // Fallback to accept any parameters
}
```

**Benefits**:
- Tools remain functional even with malformed schemas
- Prevents service disruption from schema issues
- Provides warning logs for debugging
- Maintains type safety where possible

**Code Statistics**:
- Schema validation enhancement: ~10 lines
- Existing conversion logic: ~100 lines (already present)

## Events Emitted

The enhanced client emits the following events:

- `connected`: Successful connection with server info
- `disconnected`: Clean disconnection
- `error`: Connection or operational errors
- `statusChanged`: Connection status transitions
- `toolsUpdated`: Tool list changes
- `reconnected`: Successful automatic reconnection
- `reconnectFailed`: All reconnection attempts exhausted
- `unhealthy`: Health monitor detected unhealthy state
- `healthMonitorReconnected`: Health monitor triggered successful reconnection

## Usage Examples

### Basic Connection with Retry

```typescript
const client = new McpClient(config);

// Automatically retries 3 times with exponential backoff
await client.connect();

// Or configure retry behavior
await client.connectWithRetry(5, 2000); // 5 retries, starting at 2s
```

### Monitoring Reconnection

```typescript
client.on('error', (error) => {
  console.error('Connection error:', error);
});

client.on('reconnected', () => {
  console.log('Successfully reconnected to MCP server');
});

client.on('reconnectFailed', () => {
  console.error('All reconnection attempts failed');
  // Notify user or attempt manual intervention
});
```

### Graceful Shutdown

```typescript
// Prevents auto-reconnect during shutdown
await client.disconnect();
```

## Testing Recommendations

1. **Network Failures**: Test retry logic with simulated network errors
2. **Server Crashes**: Verify auto-reconnect when server restarts
3. **Config Errors**: Ensure no retry loops on permanent errors
4. **Manual Disconnect**: Confirm no auto-reconnect after explicit disconnect
5. **Long-running Connections**: Test stability over extended periods

## Dependencies

- `@modelcontextprotocol/sdk`: Official MCP SDK from Anthropic
- No additional dependencies required

## Build Verification

All changes verified with:
```bash
pnpm install @modelcontextprotocol/sdk
npm run build
```

Build output: `blade.js 6.74 MB` (no errors)

## Future Enhancements

Potential improvements for consideration:

1. **Health Monitoring**: Periodic ping to detect zombie connections
2. **Connection Pooling**: Multiple concurrent MCP connections
3. **OAuth Support**: Enhanced authentication for remote servers
4. **Metrics Collection**: Connection stats and performance monitoring
5. **Schema Validation**: Runtime validation of MCP messages

## References

- MCP Protocol: https://modelcontextprotocol.io/
- Official SDK: https://github.com/anthropics/sdk
- Error patterns based on: neovate-code implementation
- Retry patterns based on: gemini-cli best practices
