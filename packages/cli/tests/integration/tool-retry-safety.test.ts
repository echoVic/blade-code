import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeToolInvocation } from '../../src/tools/execution/ToolInvocationRunner.js';
import type { ToolInvocation } from '../../src/tools/types/index.js';

describe('tool retry safety integration', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('does not replay a side effect when its completion is indeterminate', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'blade-tool-retry-'));
    directories.push(directory);
    const outputPath = path.join(directory, 'side-effect.txt');
    const invocation: ToolInvocation<unknown> = {
      toolName: 'SideEffect',
      params: {},
      getDescription: () => 'append one marker',
      getAffectedPaths: () => [outputPath],
      execute: async () => {
        await appendFile(outputPath, 'once\n');
        throw new Error('EBUSY: acknowledgement lost after side effect');
      },
    };

    await expect(executeToolInvocation(invocation, {})).rejects.toThrow('EBUSY');
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('once\n');
  });
});
