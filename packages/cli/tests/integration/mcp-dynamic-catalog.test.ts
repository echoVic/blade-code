import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type McpCatalogChange, McpRegistry } from '../../src/mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../src/mcp/types.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-dynamic-catalog-server.mjs'
);

describe('dynamic MCP tool catalog over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-dynamic-catalog-'));
    pidFile = path.join(root, 'server.pid');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated();
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes bounded revisions and retains the last valid catalog', async () => {
    const changes: McpCatalogChange[] = [];
    const refreshFailures: unknown[] = [];
    registry.on('catalogChanged', (change) => changes.push(change));
    registry.on('catalogRefreshFailed', (failure) => refreshFailures.push(failure));

    await registry.registerServer('dynamic', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_DYNAMIC_PID_FILE: pidFile,
        MCP_DYNAMIC_TRACE_FILE: traceFile,
      },
    });

    expect(registry.getServerStatus('dynamic')?.status).toBe(
      McpConnectionStatus.CONNECTED
    );
    expect(registry.getCatalogSnapshot().tools.map((tool) => tool.name)).toEqual([
      'mcp__dynamic__unlock_catalog',
      'mcp__dynamic__stable_marker',
      'mcp__dynamic__obsolete_marker',
    ]);
    expect(changes[0]).toMatchObject({
      revision: 1,
      reason: 'connection',
      added: [
        'mcp__dynamic__obsolete_marker',
        'mcp__dynamic__stable_marker',
        'mcp__dynamic__unlock_catalog',
      ],
      removed: [],
      updated: [],
    });

    const client = registry.getServerStatus('dynamic')!.client;
    const unlock = await client.callTool('unlock_catalog');
    expect(unlock.content[0]?.text).toBe('CATALOG_UNLOCKED');
    await expect.poll(() => registry.getCatalogSnapshot().revision).toBe(2);

    expect(registry.getCatalogSnapshot().tools.map((tool) => tool.name)).toEqual([
      'mcp__dynamic__dynamic_marker',
      'mcp__dynamic__stable_marker',
      'mcp__dynamic__poison_catalog',
    ]);
    expect(changes.at(-1)).toMatchObject({
      revision: 2,
      reason: 'notification',
      added: ['mcp__dynamic__dynamic_marker', 'mcp__dynamic__poison_catalog'],
      removed: ['mcp__dynamic__obsolete_marker', 'mcp__dynamic__unlock_catalog'],
      updated: ['mcp__dynamic__stable_marker'],
    });

    const marker = await client.callTool('dynamic_marker', {
      marker: 'CATALOG',
    });
    expect(marker.content[0]?.text).toBe('DYNAMIC_MCP_OK:CATALOG');
    const poison = await client.callTool('poison_catalog');
    expect(poison.content[0]?.text).toBe('POISON_SENT');
    await expect.poll(() => refreshFailures.length).toBe(1);

    expect(registry.getCatalogSnapshot().revision).toBe(2);
    expect(registry.getCatalogSnapshot().tools.map((tool) => tool.name)).toEqual([
      'mcp__dynamic__dynamic_marker',
      'mcp__dynamic__stable_marker',
      'mcp__dynamic__poison_catalog',
    ]);
    expect(refreshFailures[0]).toMatchObject({
      serverName: 'dynamic',
      reason: 'notification',
      error: expect.objectContaining({
        message: expect.stringContaining('duplicate tool "duplicate"'),
      }),
    });

    const trace = (await readFile(traceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(trace.filter((entry) => entry.event === 'tools_list')).toHaveLength(5);
    expect(trace.filter((entry) => entry.event === 'marker_called')).toEqual([
      expect.objectContaining({
        name: 'dynamic_marker',
        marker: 'CATALOG',
      }),
    ]);

    await expect(access(pidFile)).resolves.toBeUndefined();
    const pid = Number(await readFile(pidFile, 'utf8'));
    await registry.disconnectAll();
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
