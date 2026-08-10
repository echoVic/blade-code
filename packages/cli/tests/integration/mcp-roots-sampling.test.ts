import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../src/config/types.js';
import { McpClient } from '../../src/mcp/McpClient.js';
import { CONFIRMATION_ABORTED_REASON } from '../../src/tools/types/ExecutionTypes.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-roots-sampling-server.mjs'
);

describe('MCP roots and sampling over real stdio transport', () => {
  let root: string;
  let workspace: string;
  const clients: McpClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-roots-sampling-'));
    workspace = path.join(root, 'workspace with 空格');
    await mkdir(workspace);
    workspace = await realpath(workspace);
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    await rm(root, { recursive: true, force: true });
  });

  function createClient(options: {
    sampling?: {
      enabled: boolean;
      maxTokens?: number;
      maxRequestsPerToolCall?: number;
    };
    samplingAvailable: boolean;
    roots?: string[];
  }) {
    const client = new McpClient(
      {
        type: 'stdio',
        command: process.execPath,
        args: [serverEntry],
        sampling: options.sampling,
      },
      'roots-sampling-fixture',
      undefined,
      {
        roots: options.roots ?? [workspace],
        samplingAvailable: options.samplingAvailable,
      }
    );
    clients.push(client);
    return client;
  }

  it('returns the exact Session workspace root and samples the frozen model', async () => {
    const client = createClient({
      sampling: {
        enabled: true,
        maxTokens: 64,
        maxRequestsPerToolCall: 2,
      },
      samplingAvailable: true,
    });
    await client.connectWithRetry(1, 1);
    const approvals: unknown[] = [];
    const samples: unknown[] = [];

    const result = await client.callTool(
      'inspect_roots_and_sample',
      {},
      {
        sessionId: 'sampling-session',
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async (details) => {
            approvals.push(details);
            return { approved: true };
          },
        },
        samplingHandler: async (request) => {
          samples.push(request);
          return {
            model: 'frozen-session-model',
            role: 'assistant',
            content: { type: 'text', text: 'ROOT_SAMPLE_OK' },
            stopReason: 'endTurn',
          };
        },
      }
    );

    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.roots).toEqual([
      {
        uri: pathToFileURL(workspace).href,
        name: path.basename(workspace),
      },
    ]);
    expect(payload.sampled).toMatchObject({
      model: 'frozen-session-model',
      content: { type: 'text', text: 'ROOT_SAMPLE_OK' },
    });
    expect(approvals).toEqual([
      expect.objectContaining({
        type: 'mcpSampling',
        kind: 'execute',
        toolName: 'MCP sampling: roots-sampling-fixture',
        risks: expect.arrayContaining([expect.stringContaining('64 output tokens')]),
      }),
    ]);
    expect(samples).toEqual([
      expect.objectContaining({
        maxTokens: 64,
        preview: expect.stringContaining('ROOT_SAMPLE_OK'),
      }),
    ]);
  });

  it('does not advertise sampling unless both config and runtime support it', async () => {
    const client = createClient({
      sampling: { enabled: true },
      samplingAvailable: false,
    });
    await client.connectWithRetry(1, 1);
    const samplingHandler = vi.fn();

    const result = await client.callTool(
      'inspect_roots_and_sample',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: true }),
        },
        samplingHandler,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Method not found');
    expect(samplingHandler).not.toHaveBeenCalled();
  });

  it('returns no host roots for a remote ACP-style Session', async () => {
    const client = createClient({
      samplingAvailable: false,
      roots: [],
    });
    await client.connectWithRetry(1, 1);
    const result = await client.callTool('inspect_roots_and_sample');
    const payload = JSON.parse(result.content[0]?.text ?? '{}');

    expect(result.isError).toBe(true);
    expect(payload.roots).toEqual([]);
    expect(payload.error).toContain('Method not found');
    expect(payload.error).not.toContain(workspace);
  });

  it('bounds nested sampling requests per MCP tool call', async () => {
    const client = createClient({
      sampling: {
        enabled: true,
        maxRequestsPerToolCall: 1,
      },
      samplingAvailable: true,
    });
    await client.connectWithRetry(1, 1);
    const samplingHandler = vi.fn(async () => ({
      model: 'frozen-session-model',
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'ROOT_SAMPLE_ONE' },
      stopReason: 'endTurn',
    }));

    const result = await client.callTool(
      'sample_twice',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: true }),
        },
        samplingHandler,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('exceeded 1 requests');
    expect(samplingHandler).toHaveBeenCalledOnce();
  });

  it('rejects overlapping nested sampling requests', async () => {
    const client = createClient({
      sampling: {
        enabled: true,
        maxRequestsPerToolCall: 2,
      },
      samplingAvailable: true,
    });
    await client.connectWithRetry(1, 1);
    const samplingHandler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        model: 'frozen-session-model',
        role: 'assistant' as const,
        content: { type: 'text' as const, text: 'ROOT_SAMPLE_ONE' },
        stopReason: 'endTurn',
      };
    });

    const result = await client.callTool(
      'sample_in_parallel',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: true }),
        },
        samplingHandler,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'does not allow overlapping sampling requests'
    );
    expect(samplingHandler).toHaveBeenCalledOnce();
  });

  it('cancels pending sampling approval when the parent tool aborts', async () => {
    const client = createClient({
      sampling: { enabled: true },
      samplingAvailable: true,
    });
    await client.connectWithRetry(1, 1);
    const controller = new AbortController();
    const samplingHandler = vi.fn();
    const approvalAborted = vi.fn();
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });

    const pending = client.callTool(
      'inspect_roots_and_sample',
      {},
      {
        signal: controller.signal,
        confirmationHandler: {
          requestConfirmation: async (_details, signal) => {
            markApprovalStarted?.();
            return new Promise((resolve) => {
              signal?.addEventListener(
                'abort',
                () => {
                  approvalAborted();
                  resolve({
                    approved: false,
                    reason: CONFIRMATION_ABORTED_REASON,
                  });
                },
                { once: true }
              );
            });
          },
        },
        samplingHandler,
      }
    );
    await approvalStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(approvalAborted).toHaveBeenCalledOnce();
    expect(samplingHandler).not.toHaveBeenCalled();

    const followUpSamplingHandler = vi.fn(async () => ({
      model: 'follow-up-session-model',
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'FOLLOW_UP_OK' },
      stopReason: 'endTurn',
    }));
    const followUp = await client.callTool(
      'inspect_roots_and_sample',
      {},
      {
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: true }),
        },
        samplingHandler: followUpSamplingHandler,
      }
    );

    expect(followUp.isError).not.toBe(true);
    expect(followUpSamplingHandler).toHaveBeenCalledOnce();
  });
});
