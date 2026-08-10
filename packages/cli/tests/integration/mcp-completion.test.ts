import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/mcp/McpRegistry.js';
import { createMcpContentTools } from '../../src/tools/builtin/mcp/index.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-completion-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP completion over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let traceFile: string;
  let registries: McpRegistry[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-completion-'));
    pidFile = path.join(root, 'pids');
    traceFile = path.join(root, 'trace.jsonl');
    registries = [];
  });

  afterEach(async () => {
    await Promise.all(registries.map((registry) => registry.disconnectAll()));
    await rm(root, { recursive: true, force: true });
  });

  async function register(
    namespace = 'PRIMARY',
    options: {
      disabled?: boolean;
      trace?: string;
      pids?: string;
      delayMs?: number;
    } = {}
  ): Promise<McpRegistry> {
    const registry = McpRegistry.createIsolated();
    registries.push(registry);
    await registry.registerServer('completion', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_COMPLETION_NAMESPACE: namespace,
        MCP_COMPLETION_TRACE_FILE: options.trace ?? traceFile,
        MCP_COMPLETION_PID_FILE: options.pids ?? pidFile,
        ...(options.disabled ? { MCP_COMPLETION_DISABLED: '1' } : {}),
        ...(options.delayMs !== undefined
          ? { MCP_COMPLETION_DELAY_MS: String(options.delayMs) }
          : {}),
      },
      timeout: 2_000,
      idleTimeout: 1_000,
    });
    await registry.waitForCatalogIdle();
    return registry;
  }

  it('completes prompt and resource arguments through the model-facing tool', async () => {
    const registry = await register();
    const completionTool = createMcpContentTools(registry).find(
      (tool) => tool.name === 'CompleteMcpArgument'
    );
    expect(completionTool).toBeDefined();

    const prompt = await completionTool!.execute({
      server: 'completion',
      reference: { type: 'prompt', name: 'deploy' },
      argument: { name: 'environment', value: 'MCP' },
      context: { region: 'us-east-1' },
    });
    expect(prompt).toMatchObject({
      success: true,
      metadata: {
        serverName: 'completion',
        argumentName: 'environment',
        valueCount: 2,
        sourceValueCount: 3,
        truncated: true,
      },
    });
    expect(prompt.llmContent).toContain('PRIMARY_MCP_COMPLETION_CODE_42');
    expect(prompt.llmContent).toContain('UNTRUSTED_COMPLETION_OVERRIDE');
    expect(prompt.llmContent).not.toContain('\u200b');

    const resource = await registry.complete('completion', {
      reference: {
        type: 'resource',
        uri: 'context://workspace/{language}/{project}',
      },
      argument: { name: 'project', value: 'bla' },
      context: { language: 'typescript' },
    });
    expect(resource.values).toEqual(['PRIMARY_blade']);
    expect(resource.sourceValueCount).toBe(2);
    expect(resource.truncated).toBe(true);

    const trace = await readFile(traceFile, 'utf8');
    expect(trace).toContain('"type":"ref/prompt"');
    expect(trace).toContain('"region":"us-east-1"');
    expect(trace).toContain('"type":"ref/resource"');
    expect(trace).toContain('"language":"typescript"');
  });

  it('rejects catalog escape, unsupported capability, and supports cancellation', async () => {
    const registry = await register();
    const traceBefore = await readFile(traceFile, 'utf8');
    await expect(
      registry.complete('completion', {
        reference: { type: 'prompt', name: 'missing' },
        argument: { name: 'environment', value: '' },
      })
    ).rejects.toThrow('not present');
    expect(await readFile(traceFile, 'utf8')).toBe(traceBefore);

    const controller = new AbortController();
    const pending = registry.complete(
      'completion',
      {
        reference: { type: 'prompt', name: 'deploy' },
        argument: { name: 'environment', value: 'delay' },
      },
      controller.signal
    );
    setTimeout(() => controller.abort('test-cancel'), 25).unref();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      registry.complete('completion', {
        reference: { type: 'prompt', name: 'deploy' },
        argument: { name: 'environment', value: 'MCP' },
      })
    ).resolves.toMatchObject({
      values: expect.arrayContaining(['PRIMARY_MCP_COMPLETION_CODE_42']),
    });

    const disabledRoot = path.join(root, 'disabled');
    const disabled = await register('DISABLED', {
      disabled: true,
      trace: `${disabledRoot}.trace`,
      pids: `${disabledRoot}.pids`,
    });
    await expect(
      disabled.complete('completion', {
        reference: { type: 'prompt', name: 'deploy' },
        argument: { name: 'environment', value: '' },
      })
    ).rejects.toThrow('does not support completions');
  });

  it('isolates same-name completion servers and recycles every process', async () => {
    const primary = await register('PRIMARY');
    const secondaryTrace = path.join(root, 'secondary.trace');
    const secondaryPids = path.join(root, 'secondary.pids');
    const secondary = await register('SECONDARY', {
      trace: secondaryTrace,
      pids: secondaryPids,
    });
    const input = {
      reference: { type: 'prompt' as const, name: 'deploy' },
      argument: { name: 'environment', value: 'MCP' },
    };

    const [first, second] = await Promise.all([
      primary.complete('completion', input),
      secondary.complete('completion', input),
    ]);
    expect(first.values[0]).toBe('PRIMARY_MCP_COMPLETION_CODE_42');
    expect(second.values[0]).toBe('SECONDARY_MCP_COMPLETION_CODE_42');

    const primaryPid = Number((await readFile(pidFile, 'utf8')).trim());
    const secondaryPid = Number((await readFile(secondaryPids, 'utf8')).trim());
    expect(processExists(primaryPid)).toBe(true);
    expect(processExists(secondaryPid)).toBe(true);
    await Promise.all([primary.disconnectAll(), secondary.disconnectAll()]);
    await expect.poll(() => processExists(primaryPid)).toBe(false);
    await expect.poll(() => processExists(secondaryPid)).toBe(false);
  });

  it('enforces a bounded number of in-flight completion requests', async () => {
    const registry = await register('BOUNDED', { delayMs: 500 });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const input = {
      reference: { type: 'prompt' as const, name: 'deploy' },
      argument: { name: 'environment', value: 'delay' },
    };
    const pending = controllers.map((controller) =>
      registry.complete('completion', input, controller.signal)
    );

    await expect(registry.complete('completion', input)).rejects.toThrow(
      'too many completion requests'
    );
    for (const controller of controllers) controller.abort('test-complete');
    await Promise.all(
      pending.map((request) =>
        expect(request).rejects.toMatchObject({ name: 'AbortError' })
      )
    );
  });
});
