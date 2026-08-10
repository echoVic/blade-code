import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../src/config/types.js';
import { McpClient } from '../../src/mcp/McpClient.js';
import type { McpElicitationDetails } from '../../src/mcp/McpElicitation.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-elicitation-server.mjs'
);

describe('MCP elicitation over real stdio transport', () => {
  let client: McpClient;

  beforeEach(async () => {
    client = new McpClient(
      {
        type: 'stdio',
        command: process.execPath,
        args: [serverEntry],
      },
      'elicitation-fixture'
    );
    await client.connectWithRetry(1, 1);
  });

  afterEach(async () => {
    await client.disconnect();
  });

  it('round-trips a validated form response without exposing it to events', async () => {
    const eventPayloads: unknown[] = [];
    client.on('elicitationResolved', (event) => eventPayloads.push(event));
    let details: McpElicitationDetails | undefined;

    const result = await client.callTool(
      'collect_profile',
      {},
      {
        sessionId: 'mcp-form-session',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: {
          requestConfirmation: async (request) => {
            details = request.mcpElicitation;
            return {
              approved: true,
              elicitation: {
                action: 'accept',
                content: {
                  channel: 'stable',
                  notifications: true,
                  retries: 3,
                  owner: 'owner@example.test',
                },
              },
            };
          },
        },
      }
    );

    expect(details).toMatchObject({
      serverName: 'elicitation-fixture',
      mode: 'form',
      message: 'Choose the release profile for this deployment.',
    });
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      action: 'accept',
      content: {
        channel: 'stable',
        notifications: true,
        retries: 3,
        owner: 'owner@example.test',
      },
    });
    expect(eventPayloads).toEqual([
      {
        serverName: 'elicitation-fixture',
        mode: 'form',
        action: 'accept',
        elicitationId: undefined,
      },
    ]);
    expect(JSON.stringify(eventPayloads)).not.toContain('owner@example.test');
  });

  it('cancels invalid form content before it reaches the MCP server', async () => {
    const result = await client.callTool(
      'collect_profile',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () => ({
            approved: true,
            elicitation: {
              action: 'accept',
              content: {
                channel: 'not-a-channel',
                notifications: true,
                retries: 3,
                owner: 'owner@example.test',
              },
            },
          }),
        },
      }
    );

    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      action: 'cancel',
    });
  });

  it('fails closed when no interactive surface is attached', async () => {
    const result = await client.callTool('collect_profile');
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      action: 'cancel',
    });
  });

  it('accepts safe URL elicitation and receives its completion notification', async () => {
    const completion = new Promise<Record<string, unknown>>((resolve) => {
      client.once('elicitationCompleted', resolve);
    });
    const result = await client.callTool(
      'authorize_release',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async (request) => {
            expect(request.mcpElicitation).toMatchObject({
              mode: 'url',
              domain: 'deploy.example.test',
              elicitationId: 'release-auth-1',
            });
            return {
              approved: true,
              elicitation: { action: 'accept' },
            };
          },
        },
      }
    );

    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      action: 'accept',
    });
    await expect(completion).resolves.toEqual({
      serverName: 'elicitation-fixture',
      elicitationId: 'release-auth-1',
    });
  });

  it('cancels an in-flight elicitation when the owning tool signal aborts', async () => {
    const abortController = new AbortController();
    const requested = vi.fn();
    const confirmationAborted = vi.fn();
    const resultPromise = client.callTool(
      'collect_profile',
      {},
      {
        signal: abortController.signal,
        confirmationHandler: {
          requestConfirmation: async (_details, signal) =>
            new Promise((resolve) => {
              requested();
              signal?.addEventListener(
                'abort',
                () => {
                  confirmationAborted();
                  resolve({
                    approved: false,
                    reason: '__aborted__',
                    elicitation: { action: 'cancel' },
                  });
                },
                { once: true }
              );
            }),
        },
      }
    );
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());
    abortController.abort('test-cancel');

    await expect(resultPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'test-cancel',
    });
    expect(confirmationAborted).toHaveBeenCalledOnce();

    const followUp = await client.callTool('collect_profile');
    expect(JSON.parse(followUp.content[0]?.text ?? '{}')).toEqual({
      action: 'cancel',
    });
  });

  it('rejects overlapping interactive calls instead of cross-wiring responses', async () => {
    let release:
      | ((response: { approved: boolean; elicitation: { action: 'cancel' } }) => void)
      | undefined;
    const requested = vi.fn();
    const first = client.callTool(
      'collect_profile',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () =>
            new Promise((resolve) => {
              requested();
              release = resolve;
            }),
        },
      }
    );
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());

    await expect(client.callTool('authorize_release')).rejects.toThrow(
      'does not allow overlapping interactive tool calls'
    );
    release?.({
      approved: false,
      elicitation: { action: 'cancel' },
    });
    await expect(first).resolves.toBeDefined();
  });
});
