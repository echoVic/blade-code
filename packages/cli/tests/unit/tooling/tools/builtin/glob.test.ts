import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globTool } from '../../../../../src/tools/builtin/search/glob.js';

vi.unmock('child_process');

const FILES = [
  'README.md',
  'notes.MD',
  'src/a.ts',
  'src/Upper.TS',
  'src/nested/b.ts',
  '.github/ci.yml',
  'node_modules/dep/index.ts',
  'dist/out.ts',
  'debug.log',
  'logs/app.log',
  'ignored/skip.ts',
  'src/generated.ts',
];

describe('Glob tool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-glob-'));
    for (const file of FILES) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), file);
    }
    // 目录与单个文件两种 .gitignore 规则都要生效
    await writeFile(path.join(workspace, '.gitignore'), 'ignored/\nsrc/generated.ts\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function glob(params: Record<string, unknown>): Promise<string[]> {
    const result = await globTool.execute(
      { path: workspace, max_results: 100, ...params } as Parameters<
        typeof globTool.execute
      >[0],
      new AbortController().signal,
      { workspaceRoot: workspace }
    );
    expect(result.success).toBe(true);
    const { matches } = result.metadata as {
      matches: Array<{ relative_path: string; is_directory: boolean }>;
    };
    return matches
      .filter((match) => !match.is_directory)
      .map((match) => match.relative_path);
  }

  it.each([
    ['**/*.ts', true, ['src/a.ts', 'src/nested/b.ts']],
    ['**/*.ts', false, ['src/Upper.TS', 'src/a.ts', 'src/nested/b.ts']],
    ['*.md', false, ['README.md', 'notes.MD']],
    ['src/*.ts', true, ['src/a.ts']],
    ['**/*.log', true, ['logs/app.log']],
    ['**/*.yml', true, ['.github/ci.yml']],
  ])(
    'matches %s (case sensitive: %s) like fast-glob',
    async (pattern, caseSensitive, expected) => {
      const viaRipgrep = await glob({ pattern, case_sensitive: caseSensitive });
      const viaFastGlob = await glob({
        pattern,
        case_sensitive: caseSensitive,
        include_directories: true,
      });

      expect(viaRipgrep.sort()).toEqual(expected);
      expect(viaFastGlob.sort()).toEqual(expected);
    }
  );

  // fast-glob 的 ignore 不支持 `!` 反向规则，这是 rg 路径独有的正确行为
  it('honors .gitignore negations', async () => {
    await mkdir(path.join(workspace, 'keep'), { recursive: true });
    await writeFile(path.join(workspace, 'keep', 'drop.ts'), '');
    await writeFile(path.join(workspace, 'keep', 'kept.ts'), '');
    await writeFile(
      path.join(workspace, '.gitignore'),
      'ignored/\nsrc/generated.ts\nkeep/*\n!keep/kept.ts\n'
    );

    await expect(glob({ pattern: 'keep/*.ts' })).resolves.toEqual(['keep/kept.ts']);
  });

  it('returns the newest files first', async () => {
    await utimes(path.join(workspace, 'src/a.ts'), 1_000, 1_000);
    await utimes(path.join(workspace, 'src/Upper.TS'), 2_000, 2_000);
    await utimes(path.join(workspace, 'src/nested/b.ts'), 3_000, 3_000);

    await expect(glob({ pattern: 'src/**/*.ts', max_results: 2 })).resolves.toEqual([
      'src/nested/b.ts',
      'src/Upper.TS',
    ]);
  });
});
