import { writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  EmptyResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

if (process.env.MCP_LIFECYCLE_PID_FILE) {
  await writeFile(process.env.MCP_LIFECYCLE_PID_FILE, `${process.pid}\n`, {
    mode: 0o600,
  });
}

const server = new Server(
  {
    name: 'blade-mcp-lifecycle-fixture',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);
const configuredProgressDelay = Number(
  process.env.MCP_LIFECYCLE_PROGRESS_DELAY_MS ?? '20'
);
const progressDelay =
  Number.isSafeInteger(configuredProgressDelay) &&
  configuredProgressDelay >= 0 &&
  configuredProgressDelay <= 5_000
    ? configuredProgressDelay
    : 20;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'progressive',
      description: 'Emit bounded progress and complete',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wait_for_cancel',
      description: 'Wait until the client cancels',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'progress_until_timeout',
      description: 'Keep emitting progress until the hard timeout',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

async function report(extra, progress, total, message) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      total,
      message,
    },
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAbort(extra) {
  if (extra.signal.aborted) return;
  await new Promise((resolve) => {
    extra.signal.addEventListener('abort', resolve, { once: true });
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'progressive') {
    await report(extra, 1, 3, 'phase-one');
    await delay(progressDelay);
    await report(extra, 2, 3, 'phase-two');
    await delay(progressDelay);
    await report(extra, 3, 3, 'phase-three');
    await extra.sendRequest({ method: 'ping' }, EmptyResultSchema);
    return {
      content: [{ type: 'text', text: 'MCP_PROGRESS_OK' }],
    };
  }

  if (request.params.name === 'progress_until_timeout') {
    let progress = 0;
    while (!extra.signal.aborted) {
      progress++;
      await report(extra, progress, 10_000, `heartbeat-${progress}`);
      await delay(100);
    }
    if (process.env.MCP_LIFECYCLE_CANCEL_FILE) {
      await writeFile(process.env.MCP_LIFECYCLE_CANCEL_FILE, `timeout:${progress}\n`, {
        mode: 0o600,
      });
    }
    return {
      content: [{ type: 'text', text: 'cancelled' }],
      isError: true,
    };
  }

  await report(extra, 1, 2, 'waiting-for-cancel');
  await waitForAbort(extra);
  if (process.env.MCP_LIFECYCLE_CANCEL_FILE) {
    await writeFile(process.env.MCP_LIFECYCLE_CANCEL_FILE, 'cancelled\n', {
      mode: 0o600,
    });
  }
  return {
    content: [{ type: 'text', text: 'cancelled' }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
