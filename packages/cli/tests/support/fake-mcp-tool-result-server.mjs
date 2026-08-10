import { appendFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const pidFile = process.env.MCP_TOOL_RESULT_PID_FILE;
const traceFile = process.env.MCP_TOOL_RESULT_TRACE_FILE;
if (pidFile) await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });

async function trace(event, details = {}) {
  if (!traceFile) return;
  await appendFile(traceFile, `${JSON.stringify({ event, ...details })}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  { name: 'blade-mcp-tool-result-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'rich_result',
      description: 'Return every supported MCP tool result content type',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'large_result',
      description: 'Return a large text result that must become an artifact',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'error_result',
      description: 'Return an untrusted protocol error result',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'oversized_result',
      description: 'Return one text part above the hard safety limit',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await trace('tool_called', { name: request.params.name });
  if (request.params.name === 'rich_result') {
    return {
      content: [
        { type: 'text', text: 'RICH_TEXT_MARKER' },
        {
          type: 'image',
          data: Buffer.from('BINARY_IMAGE_SECRET').toString('base64'),
          mimeType: 'image/png',
          _meta: { secret: 'IMAGE_META_SECRET' },
        },
        {
          type: 'resource_link',
          uri: 'context://linked',
          name: 'linked-context',
          description: 'Linked result',
          mimeType: 'text/plain',
          _meta: { secret: 'LINK_META_SECRET' },
        },
        {
          type: 'resource',
          resource: {
            uri: 'context://inline',
            mimeType: 'text/plain',
            text: 'RESOURCE_TEXT_MARKER',
            _meta: { secret: 'RESOURCE_META_SECRET' },
          },
        },
        {
          type: 'resource',
          resource: {
            uri: 'context://binary',
            mimeType: 'application/octet-stream',
            blob: Buffer.from('BINARY_RESOURCE_SECRET').toString('base64'),
          },
        },
      ],
      structuredContent: {
        marker: 'STRUCTURED_RESULT_MARKER',
        count: 2,
      },
      _meta: {
        secret: 'ROOT_META_SECRET',
      },
    };
  }
  if (request.params.name === 'large_result') {
    return {
      content: [
        {
          type: 'text',
          text: `LARGE_HEAD_MARKER\n${'x'.repeat(120 * 1024)}\nLARGE_TAIL_MARKER`,
        },
      ],
    };
  }
  if (request.params.name === 'error_result') {
    return {
      content: [
        {
          type: 'text',
          text:
            'REMOTE_FAILURE https://example.test/private?token=secret ' +
            'Bearer secret-token-value sk-secretsecretsecretsecret',
        },
      ],
      isError: true,
      _meta: { secret: 'ERROR_META_SECRET' },
    };
  }
  if (request.params.name === 'oversized_result') {
    return {
      content: [
        {
          type: 'text',
          text: 'z'.repeat(1024 * 1024 + 1),
        },
      ],
    };
  }
  return {
    content: [{ type: 'text', text: 'UNKNOWN_TOOL' }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
