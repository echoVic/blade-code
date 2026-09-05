import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../src/config/types.js';
import { runFollowUpQueuePtyDriver } from '../support/followUpQueuePtyDriver.js';

vi.unmock('node:child_process');

const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const roots: string[] = [];
let createHttpServer: typeof import('node:http').createServer;

beforeAll(async () => {
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

function countMarker(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

async function startFixtureProvider() {
  const requestBodies: string[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstRequestStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstRequestStarted = resolve;
  });
  const server = createHttpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const requestNumber = requestBodies.push(Buffer.concat(chunks).toString('utf8'));
      if (requestNumber === 1) {
        firstRequestStarted();
        await firstReleased;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({
          id: `queue-fixture-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: requestNumber === 1 ? 'PRIMARY_COMPLETE' : 'QUEUE_APPLIED',
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id: `queue-fixture-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        })}\n\n`
      );
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    waitForFirstRequest: () => firstStarted,
    releaseFirst,
    close: async () => {
      releaseFirst();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')(
  'follow-up queue production raw PTY',
  () => {
    it('reorders and removes durable follow-ups across resize and reopen', async () => {
      await access(cliEntry);
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-follow-up-pty-'));
      roots.push(root);
      const workspacePath = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const provider = await startFixtureProvider();
      const firstMarker = `QUEUE_A_${Date.now()}`;
      const deletedMarker = `QUEUE_B_DELETE_${Date.now()}`;
      const movedMarker = `QUEUE_C_MOVE_${Date.now()}`;

      try {
        await Promise.all([
          mkdir(workspacePath, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          mkdir(path.join(home, '.blade'), { recursive: true }),
        ]);
        const workspace = await realpath(workspacePath);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: 'follow-up-fixture',
              models: [
                {
                  id: 'follow-up-fixture',
                  displayName: 'Follow-up fixture',
                  provider: 'deepseek',
                  model: 'deepseek-v4-flash',
                  overrides: {
                    baseUrl: provider.baseUrl,
                    maxOutputTokens: 128,
                    timeout: 60_000,
                    streamIdleTimeout: 60_000,
                    maxRetries: 0,
                  },
                },
              ],
              permissionMode: PermissionMode.YOLO,
              maxTurns: 4,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );

        const evidence = await runFollowUpQueuePtyDriver({
          workspace,
          storageRoot,
          home,
          sessionId: `follow-up-pty-${Date.now()}`,
          primaryPrompt: 'Wait for follow-up queue input, then answer briefly.',
          firstMarker,
          deletedMarker,
          movedMarker,
          expectedOutput: 'QUEUE_APPLIED',
          providerApiKey: 'deterministic-provider-key',
          waitForProviderHold: () => provider.waitForFirstRequest(),
          releaseProvider: provider.releaseFirst,
        });

        expect(evidence).toMatchObject({
          success: true,
          panelOpened: true,
          reordered: true,
          deleted: true,
          resized: true,
          reopened: true,
          finalMarkerSeen: true,
          cleanupComplete: true,
          leakedSecrets: [],
        });
        expect(provider.requestBodies).toHaveLength(2);
        const consumed = provider.requestBodies[1]!;
        expect(consumed.indexOf(firstMarker)).toBeLessThan(
          consumed.indexOf(movedMarker)
        );
        expect(consumed).not.toContain(deletedMarker);
        expect(countMarker(consumed, firstMarker)).toBe(1);
        expect(countMarker(consumed, movedMarker)).toBe(1);
      } finally {
        provider.releaseFirst();
        await provider.close();
      }
    }, 120_000);
  }
);
