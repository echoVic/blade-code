import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/mcp/McpRegistry.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-logging-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP logging over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-logging-'));
    pidFile = path.join(root, 'server.pid');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated();
    await registry.registerServer('logging', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_LOGGING_PID_FILE: pidFile,
        MCP_LOGGING_TRACE_FILE: traceFile,
      },
      logging: {
        level: 'warning',
      },
    });
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  it('negotiates the level and sanitizes accepted notifications', async () => {
    const baseline = registry.getLogSnapshot('logging').revision;
    const tool = await registry.findTool('mcp__logging__emit_logs');
    await tool!.execute({});
    const snapshot = registry.getLogSnapshot('logging', {
      afterRevision: baseline,
    });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.entries.map((entry) => entry.level)).toEqual(['warning', 'error']);
    expect(serialized).toContain('WARNING_LOG_MARKER');
    expect(serialized).toContain('ERROR_LOG_MARKER');
    expect(serialized).not.toContain('DEBUG_LOG_MARKER');
    expect(serialized).not.toContain('INFO_LOG_MARKER');
    expect(serialized).toContain('[redacted-url]');
    expect(snapshot.entries[0]?.message).toContain('"authorization":"[redacted]"');
    expect(serialized).not.toContain('RAW_ACCESS_TOKEN');
    expect(serialized).not.toContain('RAW_LOG_META_SECRET');
    expect(serialized).not.toContain('sk-serversecret');
    expect(snapshot.entries[1]?.truncated).toBe(true);
  });

  it('changes the negotiated level for the live Session', async () => {
    await registry.setServerLoggingLevel('logging', 'debug');
    const baseline = registry.getLogSnapshot('logging').revision;
    const tool = await registry.findTool('mcp__logging__emit_logs');
    await tool!.execute({});
    const snapshot = registry.getLogSnapshot('logging', {
      afterRevision: baseline,
    });

    expect(registry.getServerStatus('logging')?.logging.level).toBe('debug');
    expect(snapshot.entries.map((entry) => entry.level)).toEqual([
      'debug',
      'info',
      'warning',
      'error',
    ]);
  });

  it('bounds burst traffic and emits a synthetic drop marker', async () => {
    const baseline = registry.getLogSnapshot('logging').revision;
    const tool = await registry.findTool('mcp__logging__burst_logs');
    await tool!.execute({});
    const snapshot = registry.getLogSnapshot('logging', {
      afterRevision: baseline,
    });

    expect(snapshot.entries.length).toBeLessThanOrEqual(64);
    expect(snapshot.entries.some((entry) => entry.synthetic)).toBe(true);
    expect(JSON.stringify(snapshot)).toContain('rate exceeded');
  });

  it('hides server-controlled details for ACP-style runtimes', async () => {
    await registry.disconnectAll();
    registry = McpRegistry.createIsolated({
      exposeLogDetails: false,
    });
    await registry.registerServer('logging', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_LOGGING_PID_FILE: pidFile,
        MCP_LOGGING_TRACE_FILE: traceFile,
      },
      logging: {
        level: 'warning',
      },
    });
    const baseline = registry.getLogSnapshot('logging').revision;
    const tool = await registry.findTool('mcp__logging__emit_logs');
    await tool!.execute({});
    const serialized = JSON.stringify(
      registry.getLogSnapshot('logging', {
        afterRevision: baseline,
      })
    );

    expect(serialized).toContain('details omitted');
    expect(serialized).not.toContain('WARNING_LOG_MARKER');
    expect(serialized).not.toContain('ERROR_LOG_MARKER');
    expect(serialized).not.toContain('/private/host');
  });

  it('reclaims the server and keeps its trace structural', async () => {
    const pid = Number(await readFile(pidFile, 'utf8'));
    const tool = await registry.findTool('mcp__logging__emit_logs');
    await tool!.execute({});
    const trace = await readFile(traceFile, 'utf8');

    expect(trace).toContain('"event":"tool_called"');
    expect(trace).not.toContain('RAW_ACCESS_TOKEN');
    await registry.disconnectAll();
    await expect.poll(() => processExists(pid)).toBe(false);
  });
});
