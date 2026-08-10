import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type McpCatalogChange,
  type McpConnectionLifecycleChange,
  type McpContentCatalogChange,
  McpRegistry,
} from '../../src/mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../src/mcp/types.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-recovery-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP connection recovery over real stdio transport', () => {
  let root: string;
  let generationFile: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-recovery-'));
    generationFile = path.join(root, 'generation');
    pidFile = path.join(root, 'pids');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated();
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  it('atomically withdraws stale catalogs, restores subscriptions, and reconnects', async () => {
    const catalogChanges: McpCatalogChange[] = [];
    const contentChanges: McpContentCatalogChange[] = [];
    const connectionChanges: McpConnectionLifecycleChange[] = [];
    registry.on('catalogChanged', (change) => catalogChanges.push(change));
    registry.on('contentCatalogChanged', (change) => contentChanges.push(change));
    registry.on('connectionLifecycleChanged', (change) =>
      connectionChanges.push(change)
    );

    await registry.registerServer('recovery', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_RECOVERY_GENERATION_FILE: generationFile,
        MCP_RECOVERY_PID_FILE: pidFile,
        MCP_RECOVERY_TRACE_FILE: traceFile,
      },
      recovery: {
        maxAttempts: 3,
        initialDelayMs: 20,
        maxDelayMs: 50,
        jitterRatio: 0,
        terminalErrorThreshold: 1,
      },
    });

    expect(registry.getCatalogSnapshot().tools.map((tool) => tool.name)).toEqual([
      'mcp__recovery__crash_server',
      'mcp__recovery__generation_marker',
    ]);
    await registry.setResourceSubscription('recovery', 'context://recovery', true);

    const client = registry.getServerStatus('recovery')!.client;
    await expect(client.callTool('crash_server')).rejects.toThrow(/Connection closed/i);

    await expect
      .poll(() => connectionChanges.map((change) => change.phase))
      .toEqual(['reconnecting', 'recovered']);
    expect(connectionChanges).toEqual([
      expect.objectContaining({
        revision: 1,
        serverName: 'recovery',
        phase: 'reconnecting',
        reason: 'transport_closed',
        attempt: 1,
        maxAttempts: 3,
      }),
      expect.objectContaining({
        revision: 2,
        serverName: 'recovery',
        phase: 'recovered',
        reason: 'transport_closed',
        attempt: 1,
        maxAttempts: 3,
      }),
    ]);

    expect(registry.getServerStatus('recovery')?.status).toBe(
      McpConnectionStatus.CONNECTED
    );
    expect(registry.getCatalogSnapshot().tools.map((tool) => tool.name)).toEqual([
      'mcp__recovery__recovered_marker',
      'mcp__recovery__generation_marker',
    ]);
    expect(catalogChanges).toEqual([
      expect.objectContaining({
        revision: 1,
        reason: 'connection',
        added: ['mcp__recovery__crash_server', 'mcp__recovery__generation_marker'],
      }),
      expect.objectContaining({
        revision: 2,
        reason: 'disconnection',
        removed: ['mcp__recovery__crash_server', 'mcp__recovery__generation_marker'],
      }),
      expect.objectContaining({
        revision: 3,
        reason: 'connection',
        added: ['mcp__recovery__generation_marker', 'mcp__recovery__recovered_marker'],
      }),
    ]);
    expect(contentChanges.filter((change) => change.kind === 'resources')).toEqual([
      expect.objectContaining({ reason: 'connection', added: ['context://recovery'] }),
      expect.objectContaining({
        reason: 'disconnection',
        removed: ['context://recovery'],
      }),
      expect.objectContaining({ reason: 'connection', added: ['context://recovery'] }),
    ]);

    const result = await client.callTool('recovered_marker', {
      marker: 'REAL_STDIO',
    });
    expect(result.content[0]?.text).toBe('RECOVERED:REAL_STDIO:SUBSCRIBED_true');
    expect(
      (await registry.readResource('recovery', 'context://recovery')).contents[0]?.text
    ).toBe('RECOVERY_RESOURCE_V2');

    const trace = (await readFile(traceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      trace
        .filter((entry) => entry.event === 'resource_subscribed')
        .map((entry) => entry.generation)
    ).toEqual([1, 2]);
    expect(trace).toContainEqual(
      expect.objectContaining({
        event: 'recovered_marker_called',
        generation: 2,
        marker: 'REAL_STDIO',
        subscribed: true,
      })
    );

    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    expect(processExists(pids[0]!)).toBe(false);
    expect(processExists(pids[1]!)).toBe(true);
    await registry.disconnectAll();
    await expect.poll(() => processExists(pids[1]!)).toBe(false);
  });

  it('cancels pending backoff without spawning a replacement after disconnect', async () => {
    const connectionChanges: McpConnectionLifecycleChange[] = [];
    registry.on('connectionLifecycleChanged', (change) =>
      connectionChanges.push(change)
    );
    await registry.registerServer('cancel', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_RECOVERY_GENERATION_FILE: generationFile,
        MCP_RECOVERY_PID_FILE: pidFile,
        MCP_RECOVERY_TRACE_FILE: traceFile,
      },
      recovery: {
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 500,
        jitterRatio: 0,
      },
    });

    const client = registry.getServerStatus('cancel')!.client;
    await expect(client.callTool('crash_server')).rejects.toThrow(/Connection closed/i);
    await expect.poll(() => connectionChanges.length).toBe(1);
    expect(connectionChanges[0]?.phase).toBe('reconnecting');

    await registry.disconnectServer('cancel');
    await new Promise((resolve) => setTimeout(resolve, 650));

    expect(await readFile(generationFile, 'utf8')).toBe('1\n');
    expect(registry.getServerStatus('cancel')?.status).toBe(
      McpConnectionStatus.DISCONNECTED
    );
    expect(connectionChanges.map((change) => change.phase)).toEqual(['reconnecting']);
    await expect(access(pidFile)).resolves.toBeUndefined();
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(1);
    expect(processExists(pids[0]!)).toBe(false);
  });
});
