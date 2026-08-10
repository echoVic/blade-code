import { appendFile, writeFile } from 'node:fs/promises';
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

const pidFile = process.env.MCP_CONTENT_PID_FILE;
const traceFile = process.env.MCP_CONTENT_TRACE_FILE;
if (pidFile) await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });

let phase = 'initial';
let liveVersion = 1;
const subscriptions = new Set();

async function trace(event, details = {}) {
  if (!traceFile) return;
  await appendFile(traceFile, `${JSON.stringify({ event, ...details })}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  { name: 'blade-mcp-content-fixture', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'advance_content_catalog',
      description: 'Advance resources and prompts to revision two',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'update_live_resource',
      description: 'Update the subscribed live resource',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  await trace('resources_list', { phase, cursor: cursor ?? null });
  if (!cursor) {
    return {
      resources: [
        {
          uri: 'context://live',
          name: 'live-context',
          description:
            phase === 'initial'
              ? 'Live context version one'
              : 'Live context version two',
          mimeType: 'text/plain',
        },
      ],
      nextCursor: `${phase}-resources-page-2`,
    };
  }
  if (cursor !== `${phase}-resources-page-2`) {
    throw new Error(`unexpected resources cursor: ${cursor}`);
  }
  return {
    resources:
      phase === 'initial'
        ? [
            {
              uri: 'context://obsolete',
              name: 'obsolete-context',
              mimeType: 'text/plain',
            },
            {
              uri: 'context://binary',
              name: 'binary-context',
              mimeType: 'application/octet-stream',
            },
          ]
        : [
            {
              uri: 'context://new',
              name: 'new-context',
              mimeType: 'application/json',
            },
            {
              uri: 'context://binary',
              name: 'binary-context',
              mimeType: 'application/octet-stream',
            },
          ],
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  await trace('resource_templates_list', { phase, cursor: cursor ?? null });
  if (cursor) throw new Error(`unexpected template cursor: ${cursor}`);
  return {
    resourceTemplates: [
      {
        uriTemplate: 'context://item/{id}',
        name: 'item-context',
        description:
          phase === 'initial'
            ? 'Item template version one'
            : 'Item template version two',
        mimeType: 'application/json',
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  await trace('resource_read', { uri, liveVersion });
  if (uri === 'context://live') {
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: `LIVE_RESOURCE_V${liveVersion}`,
        },
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ version: liveVersion }),
        },
      ],
    };
  }
  if (uri === 'context://binary') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/octet-stream',
          blob: Buffer.from('BINARY_RESOURCE').toString('base64'),
        },
      ],
    };
  }
  if (uri === 'context://new') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: '{"catalog":"dynamic"}',
        },
      ],
    };
  }
  return { contents: [] };
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  await trace('prompts_list', { phase, cursor: cursor ?? null });
  if (!cursor) {
    return {
      prompts: [
        {
          name: 'compose_report',
          description:
            phase === 'initial'
              ? 'Compose report version one'
              : 'Compose report version two',
          arguments: [
            {
              name: 'topic',
              description: 'Report topic',
              required: true,
            },
          ],
        },
      ],
      nextCursor: `${phase}-prompts-page-2`,
    };
  }
  if (cursor !== `${phase}-prompts-page-2`) {
    throw new Error(`unexpected prompts cursor: ${cursor}`);
  }
  return {
    prompts:
      phase === 'initial'
        ? [{ name: 'obsolete_prompt', description: 'Removed in revision two' }]
        : [{ name: 'new_prompt', description: 'Added in revision two' }],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  await trace('prompt_get', { name, args });
  if (name !== 'compose_report') throw new Error(`unknown prompt: ${name}`);
  return {
    description: 'Resolved report prompt',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `PROMPT_OK:${String(args.topic ?? '')}` },
      },
      {
        role: 'assistant',
        content: {
          type: 'resource',
          resource: {
            uri: 'context://live',
            mimeType: 'text/plain',
            text: `LIVE_RESOURCE_V${liveVersion}`,
          },
        },
      },
    ],
  };
});

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
  if (request.params.name === 'advance_content_catalog') {
    phase = 'dynamic';
    await trace('content_catalog_advanced');
    await Promise.all([
      server.sendResourceListChanged(),
      server.sendPromptListChanged(),
    ]);
    return { content: [{ type: 'text', text: 'CONTENT_CATALOG_ADVANCED' }] };
  }
  if (request.params.name === 'update_live_resource') {
    if (!subscriptions.has('context://live')) {
      return {
        content: [{ type: 'text', text: 'LIVE_RESOURCE_NOT_SUBSCRIBED' }],
        isError: true,
      };
    }
    liveVersion++;
    await trace('live_resource_updated', { liveVersion });
    await server.sendResourceUpdated({ uri: 'context://live' });
    return { content: [{ type: 'text', text: `LIVE_RESOURCE_V${liveVersion}` }] };
  }
  return {
    content: [{ type: 'text', text: 'UNKNOWN_TOOL' }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
