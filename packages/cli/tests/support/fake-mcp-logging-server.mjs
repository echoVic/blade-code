import { appendFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const pidFile = process.env.MCP_LOGGING_PID_FILE;
const traceFile = process.env.MCP_LOGGING_TRACE_FILE;
if (pidFile) await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });

async function trace(event, details = {}) {
  if (!traceFile) return;
  await appendFile(traceFile, `${JSON.stringify({ event, ...details })}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  { name: 'blade-mcp-logging-fixture', version: '1.0.0' },
  {
    capabilities: {
      logging: {},
      tools: {},
    },
  }
);

server.oninitialized = async () => {
  await server.sendLoggingMessage({
    level: 'warning',
    logger: 'fixture.startup',
    data: 'STARTUP_LOG_MARKER',
  });
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'emit_logs',
      description: 'Emit safe and malicious MCP protocol log notifications',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'burst_logs',
      description: 'Emit enough logs to exercise the client rate limit',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await trace('tool_called', { name: request.params.name });
  if (request.params.name === 'emit_logs') {
    await server.sendLoggingMessage({
      level: 'debug',
      logger: 'fixture.debug',
      data: 'DEBUG_LOG_MARKER',
    });
    await server.sendLoggingMessage({
      level: 'info',
      logger: 'fixture.info',
      data: 'INFO_LOG_MARKER',
    });
    await server.sendLoggingMessage({
      level: 'warning',
      logger: 'fixture.warning',
      data: {
        marker: 'WARNING_LOG_MARKER',
        endpoint: 'https://example.test/private?token=secret',
        authorization: 'Bearer server-secret-token',
        accessToken: 'RAW_ACCESS_TOKEN',
        apiKey: 'sk-serversecretserversecret',
        _meta: { secret: 'RAW_LOG_META_SECRET' },
      },
    });
    await server.sendLoggingMessage({
      level: 'error',
      logger: '/private/host/fixture.error',
      data: {
        marker: 'ERROR_LOG_MARKER',
        large: 'x'.repeat(64 * 1024),
      },
    });
    return {
      content: [{ type: 'text', text: 'LOG_TOOL_OK' }],
    };
  }
  if (request.params.name === 'burst_logs') {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        server.sendLoggingMessage({
          level: 'warning',
          logger: 'fixture.burst',
          data: `BURST_LOG_${index}`,
        })
      )
    );
    return {
      content: [{ type: 'text', text: 'BURST_TOOL_OK' }],
    };
  }
  return {
    content: [{ type: 'text', text: 'UNKNOWN_TOOL' }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
