import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/mcp/McpRegistry.js';
import { McpToolArtifactStore } from '../../src/mcp/McpToolArtifactStore.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-tool-result-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP tool result safety over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-tool-result-'));
    pidFile = path.join(root, 'server.pid');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated({
      artifactWriter: new McpToolArtifactStore('result-session', {
        storageRoot: path.join(root, 'storage'),
        exposePaths: true,
      }),
    });
    await registry.registerServer('results', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_TOOL_RESULT_PID_FILE: pidFile,
        MCP_TOOL_RESULT_TRACE_FILE: traceFile,
      },
    });
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  it('normalizes rich results without projecting base64 or server metadata', async () => {
    const tool = await registry.findTool('mcp__results__rich_result');
    const result = await tool!.execute({});
    const serialized = JSON.stringify(result);

    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('RICH_TEXT_MARKER');
    expect(result.llmContent).toContain('RESOURCE_TEXT_MARKER');
    expect(result.llmContent).toContain('STRUCTURED_RESULT_MARKER');
    expect(serialized).not.toContain(
      Buffer.from('BINARY_IMAGE_SECRET').toString('base64')
    );
    expect(serialized).not.toContain(
      Buffer.from('BINARY_RESOURCE_SECRET').toString('base64')
    );
    expect(serialized).not.toContain('META_SECRET');

    const projection = result.metadata?.mcpResult as {
      artifactCount: number;
      binaryOmitted: boolean;
      artifacts: Array<{ path?: string; size: number; persisted: boolean }>;
    };
    expect(projection).toMatchObject({
      artifactCount: 2,
      binaryOmitted: true,
      truncated: false,
    });
    expect(projection.artifacts).toHaveLength(2);
    for (const artifact of projection.artifacts) {
      expect(artifact.persisted).toBe(true);
      expect(artifact.path).toBeDefined();
      expect((await stat(artifact.path!)).mode & 0o777).toBe(0o600);
    }
    await expect(readFile(projection.artifacts[0]!.path!, 'utf8')).resolves.toBe(
      'BINARY_IMAGE_SECRET'
    );
    await expect(readFile(projection.artifacts[1]!.path!, 'utf8')).resolves.toBe(
      'BINARY_RESOURCE_SECRET'
    );
  });

  it('persists large normalized text and keeps both preview boundaries', async () => {
    const tool = await registry.findTool('mcp__results__large_result');
    const result = await tool!.execute({});
    const projection = result.metadata?.mcpResult as {
      truncated: boolean;
      artifacts: Array<{ path?: string; kind: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('LARGE_HEAD_MARKER');
    expect(result.llmContent).toContain('LARGE_TAIL_MARKER');
    expect(result.llmContent).toContain('MCP tool result exceeded');
    expect(projection.truncated).toBe(true);
    const textArtifact = projection.artifacts.find(
      (artifact) => artifact.kind === 'text'
    );
    expect(textArtifact?.path).toBeDefined();
    const full = await readFile(textArtifact!.path!, 'utf8');
    expect(full).toContain('LARGE_HEAD_MARKER');
    expect(full).toContain('LARGE_TAIL_MARKER');
    expect(full.length).toBeGreaterThan(120 * 1024);
  });

  it('redacts protocol errors and rejects results above the hard limit', async () => {
    const errorTool = await registry.findTool('mcp__results__error_result');
    const remoteFailure = await errorTool!.execute({});
    expect(remoteFailure.success).toBe(false);
    expect(remoteFailure.llmContent).toContain('REMOTE_FAILURE');
    expect(remoteFailure.llmContent).toContain('[redacted-url]');
    expect(remoteFailure.llmContent).toContain('Bearer [redacted]');
    expect(JSON.stringify(remoteFailure)).not.toContain('secret-token-value');
    expect(JSON.stringify(remoteFailure)).not.toContain('sk-secret');
    expect(JSON.stringify(remoteFailure)).not.toContain('ERROR_META_SECRET');

    const oversized = await registry.findTool('mcp__results__oversized_result');
    const rejected = await oversized!.execute({});
    expect(rejected.success).toBe(false);
    expect(rejected.error?.message).toContain('exceeds');
    expect(Buffer.byteLength(String(rejected.llmContent))).toBeLessThan(8 * 1024);
  });

  it('reclaims the server and leaves a structural trace only', async () => {
    const pid = Number(await readFile(pidFile, 'utf8'));
    const tool = await registry.findTool('mcp__results__rich_result');
    await tool!.execute({});
    const trace = await readFile(traceFile, 'utf8');
    expect(trace).toContain('"event":"tool_called"');
    expect(trace).not.toContain('BINARY_IMAGE_SECRET');

    await registry.disconnectAll();
    await expect.poll(() => processExists(pid)).toBe(false);
  });
});
