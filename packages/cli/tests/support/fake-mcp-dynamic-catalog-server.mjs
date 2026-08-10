import { appendFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const pidFile = process.env.MCP_DYNAMIC_PID_FILE;
const traceFile = process.env.MCP_DYNAMIC_TRACE_FILE;
if (pidFile) {
  await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
}

let phase = 'initial';
let listRequests = 0;

async function trace(event, details = {}) {
  if (!traceFile) return;
  await appendFile(traceFile, `${JSON.stringify({ event, ...details })}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  {
    name: 'blade-dynamic-catalog-fixture',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: { listChanged: true },
    },
  }
);

const schema = {
  type: 'object',
  properties: {
    marker: { type: 'string' },
  },
  additionalProperties: false,
};

function initialTools(cursor) {
  if (!cursor) {
    return {
      tools: [
        {
          name: 'unlock_catalog',
          description: 'Unlock the dynamic catalog',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'stable_marker',
          description: 'Stable marker version one',
          inputSchema: schema,
        },
      ],
      nextCursor: 'initial-page-2',
    };
  }
  if (cursor === 'initial-page-2') {
    return {
      tools: [
        {
          name: 'obsolete_marker',
          description: 'Removed after catalog unlock',
          inputSchema: schema,
        },
      ],
    };
  }
  return { tools: [] };
}

function dynamicTools(cursor) {
  if (!cursor) {
    return {
      tools: [
        {
          name: 'dynamic_marker',
          description: 'Dynamically added marker',
          inputSchema: schema,
        },
        {
          name: 'stable_marker',
          description: 'Stable marker version two',
          inputSchema: {
            ...schema,
            required: ['marker'],
          },
        },
      ],
      nextCursor: 'dynamic-page-2',
    };
  }
  if (cursor === 'dynamic-page-2') {
    return {
      tools: [
        {
          name: 'poison_catalog',
          description: 'Attempt an invalid duplicate catalog update',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  }
  return { tools: [] };
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  listRequests++;
  await trace('tools_list', {
    phase,
    cursor: request.params?.cursor ?? null,
    listRequests,
  });
  if (phase === 'poisoned') {
    return {
      tools: [
        {
          name: 'duplicate',
          description: 'first duplicate',
          inputSchema: schema,
        },
        {
          name: 'duplicate',
          description: 'second duplicate',
          inputSchema: schema,
        },
      ],
    };
  }
  return phase === 'initial'
    ? initialTools(request.params?.cursor)
    : dynamicTools(request.params?.cursor);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === 'unlock_catalog') {
    phase = 'dynamic';
    await trace('catalog_unlocked');
    await Promise.all(Array.from({ length: 5 }, () => server.sendToolListChanged()));
    return {
      content: [{ type: 'text', text: 'CATALOG_UNLOCKED' }],
    };
  }
  if (name === 'poison_catalog') {
    phase = 'poisoned';
    await trace('catalog_poisoned');
    await server.sendToolListChanged();
    return {
      content: [{ type: 'text', text: 'POISON_SENT' }],
    };
  }
  if (name === 'dynamic_marker' || name === 'stable_marker') {
    const marker = String(request.params.arguments?.marker ?? '');
    await trace('marker_called', { name, marker });
    return {
      content: [{ type: 'text', text: `DYNAMIC_MCP_OK:${marker}` }],
    };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
