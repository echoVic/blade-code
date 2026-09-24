import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grepTool,
  parseGrepOutput,
  parseRipgrepOutput,
} from '../../../../../src/tools/builtin/search/grep.js';
import { getRipgrep } from '../../../../../src/tools/builtin/search/ripgrep.js';

vi.unmock('child_process');

// rg -n -B1 -A2 的真实输出；git grep 与系统 grep 的 content 格式相同
const BEFORE_AFTER_OUTPUT = [
  'v-2-dir/a-1-b.txt-1-one',
  'v-2-dir/a-1-b.txt:2:two: TARGET here',
  'v-2-dir/a-1-b.txt-3-three',
  'v-2-dir/a-1-b.txt-4-four',
  'v-2-dir/a-1-b.txt:5:five TARGET',
  'v-2-dir/a-1-b.txt-6-six',
  'v-2-dir/a-1-b.txt-7-seven',
  '--',
  'v-2-dir/a-1-b.txt-9-nine',
  'v-2-dir/a-1-b.txt:10:ten TARGET',
  '--',
  'z.txt-1-alpha',
  'z.txt:2:TARGET beta',
  'z.txt-3-gamma: x-9-y',
].join('\n');

describe('parseGrepOutput', () => {
  it('attaches context lines to their matches', () => {
    expect(parseGrepOutput(BEFORE_AFTER_OUTPUT, 'content', 2)).toEqual([
      {
        file_path: 'v-2-dir/a-1-b.txt',
        line_number: 2,
        content: 'two: TARGET here',
        context_before: ['one'],
        context_after: ['three', 'four'],
      },
      {
        file_path: 'v-2-dir/a-1-b.txt',
        line_number: 5,
        content: 'five TARGET',
        context_after: ['six', 'seven'],
      },
      {
        file_path: 'v-2-dir/a-1-b.txt',
        line_number: 10,
        content: 'ten TARGET',
        context_before: ['nine'],
      },
      {
        file_path: 'z.txt',
        line_number: 2,
        content: 'TARGET beta',
        context_before: ['alpha'],
        context_after: ['gamma: x-9-y'],
      },
    ]);
  });

  it('splits lines between two matches by the after-context count', () => {
    const output = [
      'a.txt:2:first TARGET',
      'a.txt-3-three',
      'a.txt-4-four',
      'a.txt:5:second TARGET',
    ].join('\n');

    expect(parseGrepOutput(output, 'content', 1)).toEqual([
      {
        file_path: 'a.txt',
        line_number: 2,
        content: 'first TARGET',
        context_after: ['three'],
      },
      {
        file_path: 'a.txt',
        line_number: 5,
        content: 'second TARGET',
        context_before: ['four'],
      },
    ]);
  });

  it('keeps Windows drive-letter paths intact', () => {
    const output = [
      'C:\\repo\\src\\a.ts-11-// setup',
      'C:\\repo\\src\\a.ts:12:x = 1;',
    ].join('\n');

    expect(parseGrepOutput(output, 'content')).toEqual([
      {
        file_path: 'C:\\repo\\src\\a.ts',
        line_number: 12,
        content: 'x = 1;',
        context_before: ['// setup'],
      },
    ]);
  });

  it('reads counts after the last colon of Windows paths', () => {
    expect(parseGrepOutput('C:\\repo\\src\\a.ts:3', 'count')).toEqual([
      { file_path: 'C:\\repo\\src\\a.ts', count: 3 },
    ]);
  });

  it('keeps colons and numbers that belong to the matched text', () => {
    expect(parseGrepOutput('z.txt:2:time 10:30:00', 'content')).toEqual([
      { file_path: 'z.txt', line_number: 2, content: 'time 10:30:00' },
    ]);
  });
});

describe('parseRipgrepOutput', () => {
  it('decodes paths and lines that ripgrep reports as bytes', () => {
    const encode = (value: string) => Buffer.from(value).toString('base64');
    const output = [
      JSON.stringify({ type: 'begin', data: { path: { bytes: encode('odd.txt') } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: encode('odd.txt') },
          lines: { bytes: encode('TARGET\n') },
          line_number: 3,
          submatches: [{ start: 0, end: 6 }],
        },
      }),
    ].join('\n');

    expect(parseRipgrepOutput(output, 'content')).toEqual([
      { file_path: 'odd.txt', line_number: 3, content: 'TARGET' },
    ]);
  });
});

describe('Grep tool', () => {
  let workspace: string;
  let notesPath: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-grep-'));
    notesPath = path.join(workspace, 'notes.txt');
    await writeFile(notesPath, 'alpha\nkey: TARGET\nomega\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function grep(params: Record<string, unknown>) {
    const result = await grepTool.execute(
      { pattern: 'TARGET', ...params } as Parameters<typeof grepTool.execute>[0],
      new AbortController().signal,
      { workspaceRoot: workspace }
    );
    expect(result.success).toBe(true);
    return result.llmContent;
  }

  it('returns -C context with the match', async () => {
    await expect(
      grep({ path: workspace, output_mode: 'content', '-C': 1 })
    ).resolves.toEqual([
      {
        file_path: notesPath,
        line_number: 2,
        content: 'key: TARGET',
        context_before: ['alpha'],
        context_after: ['omega'],
      },
    ]);
  });

  it('omits line numbers when -n is false', async () => {
    await expect(
      grep({ path: workspace, output_mode: 'content', '-C': 1, '-n': false })
    ).resolves.toEqual([
      {
        file_path: notesPath,
        content: 'key: TARGET',
        context_before: ['alpha'],
        context_after: ['omega'],
      },
    ]);
  });

  it('reports the searched file when path is a single file', async () => {
    await expect(grep({ path: notesPath, output_mode: 'content' })).resolves.toEqual([
      { file_path: notesPath, line_number: 2, content: 'key: TARGET' },
    ]);
  });

  it('ignores the user ripgrep configuration file', async () => {
    const config = path.join(workspace, 'ripgreprc');
    await writeFile(config, '--vimgrep\n');
    vi.stubEnv('RIPGREP_CONFIG_PATH', config);

    await expect(
      grep({ path: notesPath, output_mode: 'content' }).finally(() =>
        vi.unstubAllEnvs()
      )
    ).resolves.toEqual([
      { file_path: notesPath, line_number: 2, content: 'key: TARGET' },
    ]);
  });

  it('searches for patterns that start with a dash', async () => {
    const file = path.join(workspace, 'options.txt');
    await writeFile(file, '--flag value\nother\n');

    await expect(
      grep({ pattern: '--flag', path: file, output_mode: 'content' })
    ).resolves.toEqual([{ file_path: file, line_number: 1, content: '--flag value' }]);
  });

  it.skipIf(!getRipgrep()?.bundled)(
    'supports look-around with the bundled ripgrep',
    async () => {
      const file = path.join(workspace, 'code.ts');
      await writeFile(file, 'const fooBar = 1;\nconst fooBaz = 2;\n');

      await expect(
        grep({ pattern: 'foo(?=Bar)', path: file, output_mode: 'content' })
      ).resolves.toEqual([
        { file_path: file, line_number: 1, content: 'const fooBar = 1;' },
      ]);
    }
  );

  it('searches hidden files but skips version-control directories', async () => {
    await mkdir(path.join(workspace, '.github'), { recursive: true });
    await writeFile(path.join(workspace, '.github', 'ci.yml'), 'run: TARGET\n');
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await writeFile(path.join(workspace, '.git', 'config'), 'TARGET\n');

    const files = (await grep({ path: workspace })) as Array<{ file_path: string }>;

    expect(files.map((file) => file.file_path).sort()).toEqual([
      path.join(workspace, '.github', 'ci.yml'),
      notesPath,
    ]);
  });

  it('clips long lines to a window around the match', async () => {
    const file = path.join(workspace, 'bundle.min.js');
    await writeFile(file, `${'x'.repeat(2000)}TARGET${'y'.repeat(2000)}\n`);

    await expect(grep({ path: file, output_mode: 'content' })).resolves.toEqual([
      {
        file_path: file,
        line_number: 1,
        content: `…[1750 chars omitted]…${'x'.repeat(250)}TARGET${'y'.repeat(244)}…[1756 chars omitted]…`,
      },
    ]);
  });

  it('keeps context between nearby matches on the right side', async () => {
    const file = path.join(workspace, 'context.txt');
    await writeFile(file, 'a\nTARGET 1\nb\nc\nTARGET 2\nd\n');

    await expect(
      grep({ path: file, output_mode: 'content', '-B': 1, '-A': 1 })
    ).resolves.toEqual([
      {
        file_path: file,
        line_number: 2,
        content: 'TARGET 1',
        context_before: ['a'],
        context_after: ['b'],
      },
      {
        file_path: file,
        line_number: 5,
        content: 'TARGET 2',
        context_before: ['c'],
        context_after: ['d'],
      },
    ]);
  });

  it('counts matches in a single file under its path', async () => {
    await expect(grep({ path: notesPath, output_mode: 'count' })).resolves.toEqual([
      { file_path: notesPath, count: 1 },
    ]);
  });
});
