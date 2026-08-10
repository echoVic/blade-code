import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync } from 'node:fs';
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

if (process.env.MCP_ELICITATION_PID_FILE) {
  writeFileSync(process.env.MCP_ELICITATION_PID_FILE, `${process.pid}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  {
    name: 'blade-elicitation-fixture',
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
      name: 'collect_profile',
      description: 'Collect a deployment profile through MCP form elicitation',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'authorize_release',
      description: 'Request an external authorization URL',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'collect_profile') {
    const result = await server.request(
      {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Choose the release profile for this deployment.',
          requestedSchema: {
            type: 'object',
            properties: {
              channel: {
                type: 'string',
                title: 'Release channel',
                description: 'Select the deployment channel.',
                enum: ['stable', 'preview'],
                enumNames: ['Stable', 'Preview'],
              },
              notifications: {
                type: 'boolean',
                title: 'Notifications',
                description: 'Send deployment notifications.',
                default: true,
              },
              retries: {
                type: 'integer',
                title: 'Retries',
                description: 'Maximum retry count.',
                minimum: 0,
                maximum: 5,
                default: 2,
              },
              owner: {
                type: 'string',
                title: 'Owner',
                description: 'Deployment owner email.',
                format: 'email',
                minLength: 3,
              },
            },
            required: ['channel', 'notifications', 'retries', 'owner'],
          },
        },
      },
      ElicitResultSchema
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: result.action,
            content: result.content,
          }),
        },
      ],
    };
  }

  if (request.params.name === 'authorize_release') {
    const elicitationId = 'release-auth-1';
    const result = await server.request(
      {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Authorize the release in the deployment console.',
          url: 'https://deploy.example.test/authorize?state=opaque',
          elicitationId,
        },
      },
      ElicitResultSchema
    );
    if (result.action === 'accept') {
      setTimeout(() => {
        void server.notification({
          method: 'notifications/elicitation/complete',
          params: { elicitationId },
        });
      }, 10);
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ action: result.action }),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: 'Unknown tool' }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
