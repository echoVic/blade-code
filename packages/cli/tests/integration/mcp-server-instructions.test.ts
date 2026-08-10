import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type McpInstructionsChange, McpRegistry } from '../../src/mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../src/mcp/types.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-instructions-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP server instructions over real stdio transport', () => {
  let root: string;
  let generationFile: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-instructions-'));
    generationFile = path.join(root, 'generation');
    pidFile = path.join(root, 'pids');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated();
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  async function register(): Promise<void> {
    await registry.registerServer('instructions', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_INSTRUCTIONS_GENERATION_FILE: generationFile,
        MCP_INSTRUCTIONS_PID_FILE: pidFile,
        MCP_INSTRUCTIONS_TRACE_FILE: traceFile,
      },
      recovery: {
        maxAttempts: 3,
        initialDelayMs: 20,
        maxDelayMs: 50,
        jitterRatio: 0,
        terminalErrorThreshold: 1,
      },
      timeout: 2_000,
      idleTimeout: 1_000,
    });
  }

  it('publishes sanitized instructions and replaces them across recovery', async () => {
    const changes: McpInstructionsChange[] = [];
    registry.on('instructionsChanged', (change) => changes.push(change));
    await register();

    const first = registry.getInstructionsSnapshot();
    expect(first.instructions).toEqual([
      expect.objectContaining({
        serverName: 'instructions',
        text: expect.stringContaining('INSTRUCTION_VISIBLE_V1'),
        detailsOmitted: false,
      }),
    ]);
    expect(first.instructions[0]?.text).toContain('INSTRUCTION_CODE_42');
    expect(first.instructions[0]?.text).toContain(
      'Hidden Unicode must disappear: ABC.'
    );
    expect(first.instructions[0]?.text).not.toContain('\u200b');
    expect(first.instructions[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const marker = await registry.findTool('mcp__instructions__instructed_marker');
    await expect(
      marker!.execute({ code: 'INSTRUCTION_CODE_42' })
    ).resolves.toMatchObject({
      success: true,
      llmContent: expect.stringContaining('INSTRUCTION_OK_V1'),
    });

    const crash = await registry.findTool('mcp__instructions__crash_instructions');
    await expect(crash!.execute({})).resolves.toMatchObject({ success: false });
    await expect
      .poll(() => registry.getServerStatus('instructions')?.status)
      .toBe(McpConnectionStatus.CONNECTED);
    await registry.waitForCatalogIdle();

    const second = registry.getInstructionsSnapshot();
    expect(second.instructions[0]?.text).toContain('INSTRUCTION_VISIBLE_V2');
    expect(second.instructions[0]?.text).toContain('INSTRUCTION_CODE_84');
    expect(changes.map((change) => change.action)).toEqual([
      'added',
      'removed',
      'added',
    ]);

    const recovered = await registry.findTool('mcp__instructions__instructed_marker');
    await expect(
      recovered!.execute({ code: 'INSTRUCTION_CODE_84' })
    ).resolves.toMatchObject({
      success: true,
      llmContent: expect.stringContaining('INSTRUCTION_OK_V2'),
    });

    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    expect(processExists(pids[0]!)).toBe(false);
    expect(processExists(pids[1]!)).toBe(true);
    await registry.disconnectAll();
    await expect.poll(() => processExists(pids[1]!)).toBe(false);
  });

  it('projects only instruction provenance for ACP-style runtimes', async () => {
    registry = McpRegistry.createIsolated({
      exposeInstructions: false,
    });
    await register();

    const snapshot = registry.getInstructionsSnapshot();
    expect(snapshot.instructions).toEqual([
      expect.objectContaining({
        serverName: 'instructions',
        projectedBytes: 0,
        detailsOmitted: true,
      }),
    ]);
    expect(snapshot.instructions[0]?.text).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('INSTRUCTION_CODE');
    expect(JSON.stringify(snapshot)).not.toContain('/private/');
  });
});
