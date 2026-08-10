import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CreateMessageResultSchema,
  ListRootsResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

if (process.env.MCP_ROOTS_SAMPLING_PID_FILE) {
  writeFileSync(process.env.MCP_ROOTS_SAMPLING_PID_FILE, `${process.pid}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  {
    name: 'blade-roots-sampling-fixture',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'inspect_roots_and_sample',
      description: 'Read client roots and ask the client model for a marker',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'sample_twice',
      description: 'Issue two client sampling requests',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'sample_in_parallel',
      description: 'Issue overlapping client sampling requests',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

async function sample(text) {
  return server.request(
    {
      method: 'sampling/createMessage',
      params: {
        systemPrompt: 'Return only the requested marker.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text,
            },
          },
        ],
        maxTokens: 256,
        temperature: 0,
      },
    },
    CreateMessageResultSchema
  );
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let roots = { roots: [] };
  try {
    roots = await server.request({ method: 'roots/list' }, ListRootsResultSchema);
    if (request.params.name === 'sample_twice') {
      const first = await sample('Return ROOT_SAMPLE_ONE.');
      const second = await sample('Return ROOT_SAMPLE_TWO.');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ roots: roots.roots, first, second }),
          },
        ],
      };
    }
    if (request.params.name === 'sample_in_parallel') {
      const [first, second] = await Promise.all([
        sample('Return ROOT_SAMPLE_ONE.'),
        sample('Return ROOT_SAMPLE_TWO.'),
      ]);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ roots: roots.roots, first, second }),
          },
        ],
      };
    }
    const sampled = await sample('Return ROOT_SAMPLE_OK.');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ roots: roots.roots, sampled }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            roots: roots.roots,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
