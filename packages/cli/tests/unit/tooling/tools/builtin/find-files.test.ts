import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';

describe('FindFiles', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-find-files-'));
    await Promise.all([
      mkdir(path.join(workspace, 'src', 'agent', 'runtime'), { recursive: true }),
      mkdir(path.join(workspace, 'src', 'session'), { recursive: true }),
      mkdir(path.join(workspace, 'ignored'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(workspace, 'src', 'agent', 'runtime', 'SessionRuntime.ts'),
        'export class SessionRuntime {}'
      ),
      writeFile(
        path.join(workspace, 'src', 'session', 'SessionService.ts'),
        'export class SessionService {}'
      ),
      writeFile(path.join(workspace, 'ignored', 'SessionRuntimeCopy.ts'), ''),
      writeFile(path.join(workspace, '.gitignore'), 'ignored/\n'),
    ]);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('fuzzy-matches workspace file paths while respecting gitignore', async () => {
    const tools = await getBuiltinTools({
      sessionId: 'find-files-test',
      workspaceRoot: workspace,
      configDir: path.join(workspace, '.blade-test'),
    });
    const tool = tools.find((candidate) => candidate.name === 'FindFiles');

    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await tool.execute(
      { query: 'sessonruntime', max_results: 10 },
      new AbortController().signal,
      { workspaceRoot: workspace }
    );

    expect(result).toMatchObject({
      success: true,
      metadata: {
        query: 'sessonruntime',
        returned_matches: 1,
        max_results: 10,
      },
    });
    expect(result.llmContent).toContain('src/agent/runtime/SessionRuntime.ts');
    expect(result.llmContent).not.toContain('ignored/SessionRuntimeCopy.ts');
  });

  it('bounds the number of returned matches', async () => {
    const tools = await getBuiltinTools({
      sessionId: 'find-files-limit-test',
      workspaceRoot: workspace,
      configDir: path.join(workspace, '.blade-test'),
    });
    const tool = tools.find((candidate) => candidate.name === 'FindFiles');

    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await tool.execute(
      { query: 'session', max_results: 1 },
      new AbortController().signal,
      { workspaceRoot: workspace }
    );

    expect(result).toMatchObject({
      success: true,
      metadata: {
        returned_matches: 1,
        max_results: 1,
        truncated: true,
      },
    });
  });
});
