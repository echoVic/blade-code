import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const generationFile = process.env.MCP_RECOVERY_GENERATION_FILE;
const pidFile = process.env.MCP_RECOVERY_PID_FILE;
const traceFile = process.env.MCP_RECOVERY_TRACE_FILE;
if (!generationFile) throw new Error('MCP_RECOVERY_GENERATION_FILE is required');

let previousGeneration = 0;
try {
  previousGeneration = Number(await readFile(generationFile, 'utf8')) || 0;
} catch {
  // The first process creates the generation ledger.
}
const generation = previousGeneration + 1;
await writeFile(generationFile, `${generation}\n`, { mode: 0o600 });
if (pidFile) {
  await appendFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
}

async function trace(event, details = {}) {
  if (!traceFile) return;
  await appendFile(
    traceFile,
    `${JSON.stringify({ event, generation, pid: process.pid, ...details })}\n`,
    { mode: 0o600 }
  );
}

await trace('started');

const subscriptions = new Set();
const server = new Server(
  { name: 'blade-mcp-recovery-fixture', version: `1.0.${generation}` },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true },
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools:
    generation === 1
      ? [
          {
            name: 'crash_server',
            description: 'Crash this MCP process before returning a result',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'generation_marker',
            description: 'Return the current MCP process generation',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : [
          {
            name: 'recovered_marker',
            description: 'Prove that the replacement MCP process is ready',
            inputSchema: {
              type: 'object',
              properties: {
                marker: { type: 'string' },
              },
              required: ['marker'],
            },
          },
          {
            name: 'generation_marker',
            description: 'Return the current MCP process generation',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'context://recovery',
      name: 'recovery-context',
      description: `Recovery context generation ${generation}`,
      mimeType: 'text/plain',
    },
  ],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [
    {
      uri: request.params.uri,
      mimeType: 'text/plain',
      text: `RECOVERY_RESOURCE_V${generation}`,
    },
  ],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'recovery_prompt',
      description: `Recovery prompt generation ${generation}`,
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async () => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `RECOVERY_PROMPT_V${generation}`,
      },
    },
  ],
}));

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptions.add(request.params.uri);
  await trace('resource_subscribed', { uri: request.params.uri });
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptions.delete(request.params.uri);
  await trace('resource_unsubscribed', { uri: request.params.uri });
  return {};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'crash_server' && generation === 1) {
    await trace('crashing');
    setTimeout(() => process.exit(17), 10).unref();
    return new Promise(() => undefined);
  }
  if (request.params.name === 'generation_marker') {
    return {
      content: [{ type: 'text', text: `GENERATION_${generation}` }],
    };
  }
  if (request.params.name === 'recovered_marker' && generation > 1) {
    await trace('recovered_marker_called', {
      marker: request.params.arguments?.marker,
      subscribed: subscriptions.has('context://recovery'),
    });
    return {
      content: [
        {
          type: 'text',
          text: `RECOVERED:${String(request.params.arguments?.marker ?? '')}:SUBSCRIBED_${subscriptions.has(
            'context://recovery'
          )}`,
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
