import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../../src/mcp/McpClient.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-lifecycle-server.mjs'
);

describe('MCP call lifecycle over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let cancelFile: string;
  const clients: McpClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-lifecycle-'));
    pidFile = path.join(root, 'server.pid');
    cancelFile = path.join(root, 'cancelled');
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    await rm(root, { recursive: true, force: true });
  });

  async function createClient(
    timeouts: { timeout?: number; idleTimeout?: number } = {}
  ) {
    const client = new McpClient(
      {
        type: 'stdio',
        command: process.execPath,
        args: [serverEntry],
        env: {
          MCP_LIFECYCLE_PID_FILE: pidFile,
          MCP_LIFECYCLE_CANCEL_FILE: cancelFile,
          MCP_LIFECYCLE_PROGRESS_DELAY_MS: '0',
        },
        ...timeouts,
      },
      'lifecycle-fixture'
    );
    clients.push(client);
    await client.connectWithRetry(1, 1);
    return client;
  }

  it('receives ordered progress and completes the tool', async () => {
    const client = await createClient();
    const progress: unknown[] = [];
    const result = await client.callTool(
      'progressive',
      {},
      {
        progressHandler: (update) => progress.push(update),
      }
    );

    expect(result.content[0]?.text).toBe('MCP_PROGRESS_OK');
    expect(progress).toEqual([
      { progress: 1, total: 3, message: 'phase-one' },
      { progress: 2, total: 3, message: 'phase-two' },
      { progress: 3, total: 3, message: 'phase-three' },
    ]);
  });

  it('propagates parent abort to the server request', async () => {
    const client = await createClient();
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const pending = client.callTool(
      'wait_for_cancel',
      {},
      {
        signal: controller.signal,
        progressHandler: () => markStarted?.(),
      }
    );
    await started;
    controller.abort('test-cancel');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect
      .poll(async () => {
        try {
          return (await readFile(cancelFile, 'utf8')).trim();
        } catch {
          return '';
        }
      })
      .toBe('cancelled');
  });

  it('uses progress as an idle heartbeat but enforces the hard timeout', async () => {
    const client = await createClient({
      timeout: 1_200,
      idleTimeout: 1_000,
    });
    const progress: unknown[] = [];
    const startedAt = Date.now();

    await expect(
      client.callTool(
        'progress_until_timeout',
        {},
        {
          progressHandler: (update) => progress.push(update),
        }
      )
    ).rejects.toMatchObject({
      code: -32001,
      message: expect.stringContaining('timed out after 1200ms'),
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(progress.length).toBeGreaterThan(3);
    await expect
      .poll(async () => {
        try {
          return (await readFile(cancelFile, 'utf8')).startsWith('timeout:');
        } catch {
          return false;
        }
      })
      .toBe(true);
  });

  it('reclaims the stdio server after disconnect', async () => {
    const client = await createClient();
    await expect(access(pidFile)).resolves.toBeUndefined();
    const pid = Number(await readFile(pidFile, 'utf8'));
    await client.disconnect();

    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
