# Bundled Ripgrep Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Grep, Glob and the FindFiles/`@` completion index rely on the ripgrep binary shipped in the npm package.

**Architecture:** A new `ripgrep.ts` module owns binary resolution (bundled → system → `@vscode/ripgrep`, always `--no-config`) and `rg --files` listing. Grep switches to JSON/NUL output with match-centred long-line clipping; Glob (files only) and `FileNameIndex` list files through ripgrep and keep fast-glob as the fallback.

**Tech Stack:** TypeScript (strict), Node ≥ 22.19 `child_process`, ripgrep 15.2.0, fast-glob, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-24-bundled-ripgrep-optimizations-design.md`

## Global Constraints

- Work in `packages/cli`; run commands from there unless stated otherwise.
- Do not commit; the user reviews the working tree.
- Unit tests that need real processes must call `vi.unmock('child_process')` (`tests/support/setup.ts` mocks it).
- Every ripgrep invocation starts with the resolver's `args` (`--no-config`).
- `--engine auto` is passed only when the resolved binary is the bundled one.
- Environment override: `BLADE_USE_BUILTIN_RIPGREP=0` or `false` (case-insensitive) prefers the system `rg`.
- Long-line window: 500 characters; markers use the form `…[N chars omitted]…`.
- Version-control directories excluded from Grep: `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`.
- `rg --files` ignore flags: `--no-require-git --no-ignore-parent --no-ignore-global --no-ignore-exclude --no-ignore-dot`.
- Biome: single quotes, semicolons, 88-character lines; run `../../node_modules/.bin/biome check --write <files>` on touched files.
- Test command pattern: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit <file>`.

---

### Task 1: Shared ripgrep resolver

**Files:**
- Create: `src/tools/builtin/search/ripgrep.ts`
- Modify: `src/tools/builtin/search/grep.ts` (remove `getPlatformRipgrepPath`, `findVendoredRipgrep`, `getRipgrepPath`; use `getRipgrep`)
- Modify: `scripts/download-ripgrep.js` (linux-arm64 → `aarch64-unknown-linux-musl`)
- Test: create `tests/unit/tooling/tools/builtin/ripgrep.test.ts`; move the `findVendoredRipgrep` block out of `tests/unit/tooling/tools/builtin/grep.test.ts`; modify `tests/unit/tooling/tools/builtin/grep.test.ts` and `tests/unit/scripts/download-ripgrep.test.ts`

**Interfaces:**
- Produces:
  - `interface RipgrepCommand { command: string; args: string[]; bundled: boolean }`
  - `interface RipgrepCandidates { preferSystem: boolean; bundled: string | null; system: string | null; vscode: string | null; canRun: (command: string) => boolean }`
  - `chooseRipgrep(candidates: RipgrepCandidates): RipgrepCommand | null`
  - `prefersSystemRipgrep(env: NodeJS.ProcessEnv): boolean`
  - `canRunRipgrep(command: string): boolean`
  - `findVendoredRipgrep(startDir: string, relativePath: string): string | null` (moved from grep.ts)
  - `getRipgrep(): RipgrepCommand | null` (cached per process)

- [ ] **Step 1: Write the failing resolver tests**

Create `tests/unit/tooling/tools/builtin/ripgrep.test.ts`:

```ts
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRunRipgrep,
  chooseRipgrep,
  findVendoredRipgrep,
  prefersSystemRipgrep,
} from '../../../../../src/tools/builtin/search/ripgrep.js';

vi.unmock('child_process');

describe('chooseRipgrep', () => {
  const available = {
    bundled: '/pkg/vendor/rg',
    system: '/usr/bin/rg',
    vscode: '/pkg/node_modules/@vscode/ripgrep/bin/rg',
    canRun: () => true,
  };

  it('prefers the bundled binary and disables user configuration', () => {
    expect(chooseRipgrep({ ...available, preferSystem: false })).toEqual({
      command: '/pkg/vendor/rg',
      args: ['--no-config'],
      bundled: true,
    });
  });

  it('uses the system binary first when builtin ripgrep is disabled', () => {
    expect(chooseRipgrep({ ...available, preferSystem: true })).toEqual({
      command: '/usr/bin/rg',
      args: ['--no-config'],
      bundled: false,
    });
  });

  it('skips a bundled binary that cannot run', () => {
    expect(
      chooseRipgrep({ ...available, preferSystem: false, canRun: () => false })
    ).toEqual({ command: '/usr/bin/rg', args: ['--no-config'], bundled: false });
  });

  it('falls back to @vscode/ripgrep and then to nothing', () => {
    expect(
      chooseRipgrep({ ...available, bundled: null, system: null, preferSystem: false })
    ).toEqual({
      command: '/pkg/node_modules/@vscode/ripgrep/bin/rg',
      args: ['--no-config'],
      bundled: false,
    });
    expect(
      chooseRipgrep({
        bundled: null,
        system: null,
        vscode: null,
        canRun: () => true,
        preferSystem: false,
      })
    ).toBeNull();
  });
});

describe('prefersSystemRipgrep', () => {
  it.each([
    ['0', true],
    ['false', true],
    [' FALSE ', true],
    ['1', false],
    [undefined, false],
  ])('BLADE_USE_BUILTIN_RIPGREP=%s', (value, expected) => {
    expect(prefersSystemRipgrep({ BLADE_USE_BUILTIN_RIPGREP: value })).toBe(expected);
  });
});

describe('canRunRipgrep', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'blade-rg-probe-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a binary that cannot run', async () => {
    const binary = path.join(directory, 'rg');
    await writeFile(binary, 'not an executable');
    await chmod(binary, 0o755);

    expect(canRunRipgrep(binary)).toBe(false);
  });

  it('accepts an executable that answers --version', async () => {
    const binary = path.join(directory, 'rg');
    await writeFile(binary, '#!/bin/sh\necho "ripgrep 0.0.0"\n');
    await chmod(binary, 0o755);

    expect(canRunRipgrep(binary)).toBe(true);
  });
});
```

Move the whole `describe('findVendoredRipgrep', …)` block (and its `mkdir` import) from `grep.test.ts` to the end of this file, importing `findVendoredRipgrep` from `ripgrep.js`.

- [ ] **Step 2: Write the failing Grep configuration test**

In `grep.test.ts`, inside `describe('Grep tool', …)`:

```ts
  it('ignores the user ripgrep configuration file', async () => {
    const config = path.join(workspace, 'ripgreprc');
    await writeFile(config, '--vimgrep\n');
    vi.stubEnv('RIPGREP_CONFIG_PATH', config);

    await expect(
      grep({ path: notesPath, output_mode: 'content' }).finally(() => vi.unstubAllEnvs())
    ).resolves.toEqual([{ file_path: notesPath, line_number: 2, content: 'key: TARGET' }]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/ripgrep.test.ts tests/unit/tooling/tools/builtin/grep.test.ts`
Expected: ripgrep.test.ts fails to import `ripgrep.js`; the configuration test fails with content `'1:key: TARGET'`-style column prefixes.

- [ ] **Step 4: Implement `ripgrep.ts`**

```ts
import { execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** 解析出的 rg 命令；args 需放在调用方参数之前 */
export interface RipgrepCommand {
  command: string;
  args: string[];
  /** 随 npm 包发布的内置 rg：版本确定且编译了 PCRE2 */
  bundled: boolean;
}

export interface RipgrepCandidates {
  preferSystem: boolean;
  bundled: string | null;
  system: string | null;
  vscode: string | null;
  canRun: (command: string) => boolean;
}

const PLATFORM_BINARIES: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64/rg',
  'darwin-x64': 'darwin-x64/rg',
  'linux-arm64': 'linux-arm64/rg',
  'linux-x64': 'linux-x64/rg',
  'win32-x64': 'win32-x64/rg.exe',
};

/** 源码与打包产物所在目录深度不同，以最近的 package.json 所在目录作为包根查找内置 rg */
export function findVendoredRipgrep(
  startDir: string,
  relativePath: string
): string | null {
  let packageRoot = startDir;
  while (!existsSync(join(packageRoot, 'package.json'))) {
    const parent = dirname(packageRoot);
    if (parent === packageRoot) {
      return null;
    }
    packageRoot = parent;
  }

  const binaryPath = join(packageRoot, 'vendor', 'ripgrep', relativePath);
  return existsSync(binaryPath) ? binaryPath : null;
}

/** BLADE_USE_BUILTIN_RIPGREP=0/false 时优先使用系统 rg */
export function prefersSystemRipgrep(env: NodeJS.ProcessEnv): boolean {
  const value = env.BLADE_USE_BUILTIN_RIPGREP?.trim().toLowerCase();
  return value === '0' || value === 'false';
}

/** 默认内置 rg 优先，其次系统 rg、@vscode/ripgrep；内置 rg 无法执行时跳过 */
export function chooseRipgrep(candidates: RipgrepCandidates): RipgrepCommand | null {
  type Candidate = [() => string | null, boolean];
  const bundled: Candidate = [
    () =>
      candidates.bundled && candidates.canRun(candidates.bundled)
        ? candidates.bundled
        : null,
    true,
  ];
  const system: Candidate = [() => candidates.system, false];
  const vscode: Candidate = [() => candidates.vscode, false];
  const order = candidates.preferSystem
    ? [system, bundled, vscode]
    : [bundled, system, vscode];

  for (const [pick, isBundled] of order) {
    const command = pick();
    if (command) {
      // Blade 解析 rg 的输出，任何来源都不能受用户 ripgrep 配置影响
      return { command, args: ['--no-config'], bundled: isBundled };
    }
  }
  return null;
}

/** 以 --version 探测二进制能否执行（如 glibc 版本跑在 musl 系统、noexec 挂载） */
export function canRunRipgrep(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function findBundledRipgrep(): string | null {
  const relativePath = PLATFORM_BINARIES[`${process.platform}-${process.arch}`];
  if (!relativePath) {
    return null;
  }
  return findVendoredRipgrep(dirname(fileURLToPath(import.meta.url)), relativePath);
}

function findSystemRipgrep(): string | null {
  try {
    const command =
      process.platform === 'win32'
        ? 'where rg'
        : 'command -v rg 2>/dev/null || which rg 2>/dev/null';
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function findVscodeRipgrep(): string | null {
  try {
    const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as {
      rgPath?: string;
    };
    return rgPath && existsSync(rgPath) ? rgPath : null;
  } catch {
    return null;
  }
}

let resolvedRipgrep: RipgrepCommand | null | undefined;

/** 进程内缓存的 rg 解析结果 */
export function getRipgrep(): RipgrepCommand | null {
  if (resolvedRipgrep === undefined) {
    resolvedRipgrep = chooseRipgrep({
      preferSystem: prefersSystemRipgrep(process.env),
      bundled: findBundledRipgrep(),
      system: findSystemRipgrep(),
      vscode: findVscodeRipgrep(),
      canRun: canRunRipgrep,
    });
  }
  return resolvedRipgrep;
}
```

- [ ] **Step 5: Switch Grep to the resolver**

In `grep.ts`: delete `getPlatformRipgrepPath`, `findVendoredRipgrep` and `getRipgrepPath`; drop the now-unused `dirname`/`fileURLToPath` imports; add `import { getRipgrep, type RipgrepCommand } from './ripgrep.js';`. Change `executeRipgrep` to take the resolved command:

```ts
async function executeRipgrep(
  rg: RipgrepCommand,
  args: string[],
  outputMode: string,
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(rg.command, [...rg.args, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // …rest of the existing body unchanged
```

and in `execute`:

```ts
      // 策略 1: 尝试使用 ripgrep
      const rg = getRipgrep();
      if (rg) {
        try {
          updateOutput?.(`使用 ripgrep (${rg.command})`);

          const args = buildRipgrepArgs({
            // …existing fields
          });

          result = await executeRipgrep(rg, args, output_mode, signal, updateOutput);
```

- [ ] **Step 6: Ship a static linux-arm64 binary**

In `tests/unit/scripts/download-ripgrep.test.ts` change the linux-arm64 target to `'aarch64-unknown-linux-musl'` (in `TARGETS` and in the "missing archive" test), run the file and see it fail, then change `scripts/download-ripgrep.js`:

```js
  {
    name: 'Linux (ARM64)',
    rgPlatform: 'aarch64-unknown-linux-musl',
    bladePlatform: 'linux-arm64',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/ripgrep.test.ts tests/unit/tooling/tools/builtin/grep.test.ts tests/unit/scripts/download-ripgrep.test.ts`
Expected: all pass. Then `node scripts/download-ripgrep.js` and confirm `file vendor/ripgrep/linux-arm64/rg` reports a statically linked aarch64 binary.

---

### Task 2: Grep on the bundled ripgrep

**Files:**
- Modify: `src/tools/builtin/search/grep.ts`
- Modify: `docs/reference/tool-list.md`, `docs/en/reference/tool-list.md` (Grep section)
- Test: `tests/unit/tooling/tools/builtin/grep.test.ts`

**Interfaces:**
- Consumes: `getRipgrep()`, `RipgrepCommand` from Task 1.
- Produces: `parseRipgrepOutput(output: string, outputMode: string, contextAfter?: number): GrepMatch[]` (exported for tests); `buildRipgrepArgs` gains `bundled: boolean`.

- [ ] **Step 1: Write the failing tests**

Add `getRipgrep` and `parseRipgrepOutput` to the imports in `grep.test.ts`, then add inside `describe('Grep tool', …)`:

```ts
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
```

and a parser test in a new `describe('parseRipgrepOutput', …)`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/grep.test.ts`
Expected: dash pattern fails (`success` false — rg rejects the flag), look-around fails (regex parse error), hidden files returns only `notes.txt`, long line returns the full 4006-character line, `parseRipgrepOutput` is not a function. The nearby-context test already passes (guard).

- [ ] **Step 3: Implement the arguments**

In `buildRipgrepArgs` add `bundled: boolean` to the options and replace the body up to the context flags with:

```ts
  const args: string[] = ['--hidden'];

  // 内置 rg 编译了 PCRE2：前后断言、反向引用等自动切换引擎
  if (options.bundled) {
    args.push('--engine', 'auto');
  }

  if (options.case_insensitive) {
    args.push('-i');
  }

  if (options.multiline) {
    args.push('-U', '--multiline-dotall');
  }

  // 输出模式：content 用 JSON 事件，其余用 NUL 分隔，路径不再有歧义
  switch (options.output_mode) {
    case 'files_with_matches':
      args.push('-l', '--null');
      break;
    case 'count':
      args.push('-c', '--with-filename', '--null');
      break;
    case 'content':
      args.push('--json');
      break;
  }
```

before the default excluded directories add:

```ts
  // --hidden 会进入点目录，版本库目录需要显式排除
  for (const dir of VCS_DIRECTORIES) {
    args.push('--glob', `!${dir}`);
  }
```

with `const VCS_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];` near the top of the file, and replace `args.push(options.pattern);` with:

```ts
  // 以 - 开头的模式不能被当成参数
  args.push('-e', options.pattern);
```

Pass `bundled: rg.bundled` from `execute`.

- [ ] **Step 4: Implement the parser**

Add below `parseGrepOutput`:

```ts
const MAX_LINE_LENGTH = 500;

interface RipgrepJsonText {
  text?: string;
  bytes?: string;
}

interface RipgrepJsonEvent {
  type: string;
  data?: {
    path?: RipgrepJsonText;
    lines?: RipgrepJsonText;
    line_number?: number | null;
    submatches?: Array<{ start: number }>;
  };
}

function decodeRipgrepText(value: RipgrepJsonText | undefined): string {
  return value?.text ?? Buffer.from(value?.bytes ?? '', 'base64').toString('utf8');
}

/** 超长行只保留 focus 附近的窗口，两端标注省略的字符数 */
function clipLine(line: string, focus: number): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  const start = Math.max(
    0,
    Math.min(line.length - MAX_LINE_LENGTH, focus - MAX_LINE_LENGTH / 2)
  );
  const end = start + MAX_LINE_LENGTH;
  const head = start > 0 ? `…[${start} chars omitted]…` : '';
  const tail = end < line.length ? `…[${line.length - end} chars omitted]…` : '';
  return `${head}${line.slice(start, end)}${tail}`;
}

/** 多行匹配逐行裁剪，首个子匹配所在的行以子匹配为中心 */
function clipMatchText(text: string, focus: number): string {
  let offset = 0;
  return text
    .split('\n')
    .map((line) => {
      const lineFocus = focus - offset;
      offset += line.length + 1;
      return clipLine(line, lineFocus >= 0 && lineFocus < line.length ? lineFocus : 0);
    })
    .join('\n');
}

/** rg 输出：content 为 --json 事件流，files_with_matches 与 count 为 NUL 分隔 */
export function parseRipgrepOutput(
  output: string,
  outputMode: string,
  contextAfter = 0
): GrepMatch[] {
  switch (outputMode) {
    case 'files_with_matches':
      return output
        .split('\0')
        .filter(Boolean)
        .map((file_path) => ({ file_path }));

    case 'count':
      return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separatorIndex = line.lastIndexOf('\0');
          return {
            file_path: line.substring(0, separatorIndex),
            count: parseInt(line.substring(separatorIndex + 1), 10),
          };
        });

    case 'content':
      return parseRipgrepJson(output, contextAfter);

    default:
      return [];
  }
}

/** 按行号挂接上下文：前一条匹配 after 范围内的行归它，其余归下一条匹配的 before */
function parseRipgrepJson(output: string, contextAfter: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  let previous: { match: GrepMatch; lastLine: number } | undefined;
  let pending: string[] = [];

  for (const line of output.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as RipgrepJsonEvent;
    const data = event.data;

    if (event.type === 'begin' || event.type === 'end') {
      previous = undefined;
      pending = [];
      continue;
    }
    if (!data || (event.type !== 'match' && event.type !== 'context')) continue;

    const raw = decodeRipgrepText(data.lines);
    const text = raw.replace(/\r?\n$/, '');
    const lineNumber = data.line_number ?? 0;

    if (event.type === 'context') {
      const clipped = clipLine(text, 0);
      if (previous && lineNumber - previous.lastLine <= contextAfter) {
        (previous.match.context_after ??= []).push(clipped);
      } else {
        pending.push(clipped);
      }
      continue;
    }

    const byteStart = data.submatches?.[0]?.start ?? 0;
    const focus = Buffer.from(raw).subarray(0, byteStart).toString('utf8').length;
    const match: GrepMatch = {
      file_path: decodeRipgrepText(data.path),
      line_number: lineNumber,
      content: clipMatchText(text, focus),
    };
    if (pending.length > 0) {
      match.context_before = pending;
      pending = [];
    }
    matches.push(match);
    previous = { match, lastLine: lineNumber + text.split('\n').length - 1 };
  }

  return matches;
}
```

In `execute`, parse ripgrep output with the new parser:

```ts
      } else {
        // 解析 grep 输出
        const contextAfterLines = contextLines ?? contextAfter ?? 0;
        matches =
          strategy === SearchStrategy.RIPGREP
            ? parseRipgrepOutput(result.stdout, output_mode, contextAfterLines)
            : parseGrepOutput(result.stdout, output_mode, contextAfterLines);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/grep.test.ts`
Expected: all pass.

- [ ] **Step 6: Document Grep**

Replace the Grep parameter table and features in `docs/reference/tool-list.md` with:

```markdown
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | 搜索正则表达式 |
| `path` | string | | 搜索文件或目录（默认工作区） |
| `glob` | string | | 文件过滤模式（rg `--glob`） |
| `type` | string | | 文件类型（rg `--type`） |
| `output_mode` | string | | `content` / `files_with_matches`（默认）/ `count` |
| `-i` | boolean | | 忽略大小写 |
| `-n` | boolean | | content 模式显示行号，默认 true |
| `-A` / `-B` / `-C` | number | | 匹配后 / 前 / 前后的上下文行数 |
| `head_limit` / `offset` | number | | 分页返回结果 |
| `multiline` | boolean | | 跨行匹配 |

**类型**: ReadOnly  
**特性**: 优先使用随包发布的 ripgrep 15.2.0（设置 `BLADE_USE_BUILTIN_RIPGREP=0` 改为系统 rg 优先），并始终忽略用户的 ripgrep 配置；使用内置版本时前后断言、反向引用自动切换到 PCRE2；搜索隐藏文件但排除 `.git` 等版本库目录；超过 500 字符的行只返回匹配附近的片段；四级智能降级（ripgrep → git grep → system grep → JS fallback）
```

and the English equivalent in `docs/en/reference/tool-list.md`:

```markdown
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Search regular expression |
| `path` | string | | File or directory to search (default: workspace) |
| `glob` | string | | File filter pattern (rg `--glob`) |
| `type` | string | | File type (rg `--type`) |
| `output_mode` | string | | `content` / `files_with_matches` (default) / `count` |
| `-i` | boolean | | Case insensitive |
| `-n` | boolean | | Show line numbers in content mode, default true |
| `-A` / `-B` / `-C` | number | | Context lines after / before / around matches |
| `head_limit` / `offset` | number | | Paginate results |
| `multiline` | boolean | | Match across lines |

**Type**: ReadOnly  
**Features**: Prefers the ripgrep 15.2.0 binary shipped with the package (set `BLADE_USE_BUILTIN_RIPGREP=0` to prefer the system `rg`) and always ignores the user's ripgrep configuration; with the bundled binary, look-around and back-references switch to PCRE2 automatically; searches hidden files but skips `.git` and other version-control directories; lines longer than 500 characters return only a window around the match; four-level smart fallback (ripgrep → git grep → system grep → JS fallback)
```

---

### Task 3: `rg --files` listing and Glob

**Files:**
- Modify: `src/tools/builtin/search/ripgrep.ts` (add `listFilesWithRipgrep`)
- Modify: `src/tools/builtin/search/glob.ts`
- Modify: `docs/reference/tool-list.md`, `docs/en/reference/tool-list.md` (Glob section)
- Test: create `tests/unit/tooling/tools/builtin/glob.test.ts`

**Interfaces:**
- Consumes: `getRipgrep()` from Task 1; `getExcludePatterns()` from `src/utils/filePatterns.ts`.
- Produces:
  - `interface RipgrepFileListOptions { cwd: string; pattern?: string; caseSensitive?: boolean; hidden: boolean; ignore: readonly string[]; sortNewest?: boolean; signal?: AbortSignal }`
  - `listFilesWithRipgrep(options: RipgrepFileListOptions): Promise<string[] | null>` — relative, `/`-separated paths; `null` means "use fast-glob".

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tooling/tools/builtin/glob.test.ts`:

```ts
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
];

describe('Glob tool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-glob-'));
    for (const file of FILES) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), file);
    }
    await writeFile(path.join(workspace, '.gitignore'), 'ignored/\n');
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
    return matches.filter((match) => !match.is_directory).map((match) => match.relative_path);
  }

  it.each([
    ['**/*.ts', true, ['src/a.ts', 'src/nested/b.ts']],
    ['**/*.ts', false, ['src/Upper.TS', 'src/a.ts', 'src/nested/b.ts']],
    ['*.md', false, ['README.md', 'notes.MD']],
    ['src/*.ts', true, ['src/a.ts']],
    ['**/*.log', true, ['logs/app.log']],
    ['**/*.yml', true, ['.github/ci.yml']],
  ])('matches %s (case sensitive: %s) like fast-glob', async (pattern, caseSensitive, expected) => {
    const viaRipgrep = await glob({ pattern, case_sensitive: caseSensitive });
    const viaFastGlob = await glob({
      pattern,
      case_sensitive: caseSensitive,
      include_directories: true,
    });

    expect(viaRipgrep.sort()).toEqual(expected);
    expect(viaFastGlob.sort()).toEqual(expected);
  });

  // fast-glob 的 ignore 不支持 `!` 反向规则，这是 rg 路径独有的正确行为
  it('honors .gitignore negations', async () => {
    await mkdir(path.join(workspace, 'keep'), { recursive: true });
    await writeFile(path.join(workspace, 'keep', 'drop.ts'), '');
    await writeFile(path.join(workspace, 'keep', 'kept.ts'), '');
    await writeFile(path.join(workspace, '.gitignore'), 'ignored/\nkeep/*\n!keep/kept.ts\n');

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/glob.test.ts`
Expected: the `it.each` cases pass (fast-glob serves both calls today), the negation test returns `[]`, the newest-first test returns `['src/Upper.TS', 'src/a.ts']`.

- [ ] **Step 3: Implement `listFilesWithRipgrep`**

Append to `ripgrep.ts` (add `spawn` to the `child_process` import and import `picomatch`):

```ts
export interface RipgrepFileListOptions {
  cwd: string;
  /** 相对 cwd 的 fast-glob 风格模式；省略时列出全部文件 */
  pattern?: string;
  caseSensitive?: boolean;
  hidden: boolean;
  /** 相对 cwd 的 fast-glob 风格忽略模式 */
  ignore: readonly string[];
  sortNewest?: boolean;
  signal?: AbortSignal;
}

// 与 FileFilter 一致：只遵循搜索根目录及其子目录中的 .gitignore，非 Git 目录同样生效
const FILE_LIST_IGNORE_FLAGS = [
  '--no-require-git',
  '--no-ignore-parent',
  '--no-ignore-global',
  '--no-ignore-exclude',
  '--no-ignore-dot',
];

/** fast-glob 的相对模式从 cwd 开始匹配；rg 按 gitignore 规则匹配任意层级，需加前导 / 锚定 */
function anchorGlob(pattern: string): string {
  return pattern.startsWith('/') ? pattern : `/${pattern}`;
}

/** 用 rg --files 列出相对 cwd 的文件；rg 不可用或执行失败时返回 null，由调用方回退 fast-glob */
export async function listFilesWithRipgrep(
  options: RipgrepFileListOptions
): Promise<string[] | null> {
  const rg = getRipgrep();
  if (!rg) {
    return null;
  }
  options.signal?.throwIfAborted();

  const args = [...rg.args, '--files', '--null', ...FILE_LIST_IGNORE_FLAGS];
  if (options.hidden) {
    args.push('--hidden');
  }
  for (const pattern of options.ignore) {
    args.push('--glob', `!${anchorGlob(pattern)}`);
  }
  if (options.sortNewest) {
    args.push('--sortr=modified');
  }

  const output = await new Promise<string | null>((resolve, reject) => {
    const signal = options.signal;
    try {
      const child = spawn(rg.command, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      const onAbort = () => {
        child.kill('SIGTERM');
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        // 退出码 1 表示没有文件
        if (code === 0 || code === 1) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });

  if (output === null) {
    return null;
  }
  // 包含模式不能交给 rg：--glob 是覆盖规则，会让 .gitignore 忽略的文件重新出现；
  // 在进程内用 picomatch 过滤，与 fast-glob 的匹配语义一致
  const matchesPattern = options.pattern
    ? picomatch(options.pattern, {
        dot: options.hidden,
        nocase: options.caseSensitive === false,
      })
    : () => true;
  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => matchesPattern(file));
}
```

> Implementation note: the first version passed the pattern as `--glob`/`--iglob`. The
> `src/generated.ts` fixture (ignored by `.gitignore`) proved that ripgrep's
> `--glob` overrides ignore files, so the pattern is matched with picomatch instead
> (add `import picomatch from 'picomatch';`).

- [ ] **Step 4: Use it in Glob**

In `glob.ts`, add imports `isAbsolute` (from `path`), `getExcludePatterns` (from `../../../utils/filePatterns.js`) and `listFilesWithRipgrep` (from `./ripgrep.js`). Replace the `FileFilter.create(…)` + `performGlobSearch(…)` block with:

```ts
      // rg --files 只能列出文件；列目录、绝对路径、上级路径与否定模式仍用 fast-glob
      const listed =
        !include_directories && isPlainRelativeGlob(pattern)
          ? await listFilesWithRipgrep({
              cwd: searchPath,
              pattern,
              caseSensitive: case_sensitive,
              hidden: true,
              ignore: getExcludePatterns(),
              sortNewest: true,
              signal,
            })
          : null;

      const { matches, wasTruncated } = listed
        ? await describeFiles(searchPath, listed, max_results)
        : await performGlobSearch(
            searchPath,
            pattern,
            {
              maxResults: max_results,
              includeDirectories: include_directories,
              caseSensitive: case_sensitive,
              signal,
            },
            // 创建文件过滤器（会读取并解析 .gitignore 一次）
            await FileFilter.create({
              cwd: searchPath,
              useGitignore: true,
              useDefaults: true,
              gitignoreScanMode: 'recursive',
              customScanIgnore: [],
              cacheTTL: 30000,
            })
          );
```

and add the helpers next to `sortMatches`:

```ts
/** rg 的 glob 以搜索根为基准，无法表达绝对路径、上级目录与否定模式 */
function isPlainRelativeGlob(pattern: string): boolean {
  return (
    !isAbsolute(pattern) && !pattern.startsWith('!') && !pattern.split('/').includes('..')
  );
}

/** rg 已按修改时间倒序，这里只补充 size 与 mtime */
async function describeFiles(
  searchPath: string,
  files: string[],
  maxResults: number
): Promise<{ matches: FileMatch[]; wasTruncated: boolean }> {
  const matches: FileMatch[] = [];
  for (const relativePath of files.slice(0, maxResults)) {
    const absolutePath = join(searchPath, relativePath);
    try {
      const stats = await stat(absolutePath);
      matches.push({
        path: absolutePath,
        relative_path: relativePath,
        is_directory: false,
        size: stats.size,
        modified: stats.mtime.toISOString(),
      });
    } catch {
      // 列出后被删除的文件直接跳过
    }
  }
  return { matches, wasTruncated: files.length > maxResults };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/tooling/tools/builtin/glob.test.ts`
Expected: all pass.

- [ ] **Step 6: Document Glob**

Replace the Glob parameter table and features in `docs/reference/tool-list.md`:

```markdown
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | glob 匹配模式（相对搜索目录） |
| `path` | string | | 搜索目录（默认工作区） |
| `max_results` | number | | 最大结果数，默认 100，最大 1000 |
| `include_directories` | boolean | | 是否包含目录，默认 false |
| `case_sensitive` | boolean | | 是否区分大小写，默认 false |

**类型**: ReadOnly
**特性**: 只列文件时使用内置 ripgrep，按修改时间从新到旧返回；列目录或 ripgrep 不可用时使用 fast-glob；遵循 `.gitignore`（含 `!` 反向规则），内置忽略 node_modules 等常见目录
```

and in `docs/en/reference/tool-list.md`:

```markdown
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Glob pattern, relative to the search directory |
| `path` | string | | Search directory (default: workspace) |
| `max_results` | number | | Maximum results, default 100, at most 1000 |
| `include_directories` | boolean | | Include directories, default false |
| `case_sensitive` | boolean | | Case-sensitive matching, default false |

**Type**: ReadOnly  
**Features**: Lists files with the bundled ripgrep, newest first; uses fast-glob for directory listings or when ripgrep is unavailable; respects `.gitignore` (including `!` negations) and built-in ignores such as node_modules
```

---

### Task 4: File-name index on `rg --files`

**Files:**
- Modify: `src/services/FileNameIndex.ts`
- Modify: `docs/reference/tool-list.md`, `docs/en/reference/tool-list.md` (FindFiles features)
- Test: `tests/unit/services/file-name-index.test.ts`

**Interfaces:**
- Consumes: `listFilesWithRipgrep` from Task 3; `getExcludePatterns()`.
- Produces: unchanged public API of `FileNameIndex`.

- [ ] **Step 1: Write the failing tests**

At the top of `file-name-index.test.ts` add `vi` to the vitest import and `vi.unmock('child_process');`. Add:

```ts
  it('lists files with their parent directories and skips empty or ignored ones', async () => {
    await mkdir(path.join(workspace, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'nested', 'Deep.ts'), '');
    await mkdir(path.join(workspace, 'empty'), { recursive: true });
    await mkdir(path.join(workspace, '.hidden'), { recursive: true });
    await writeFile(path.join(workspace, '.hidden', 'Secret.ts'), '');
    await mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), '');
    await mkdir(path.join(workspace, 'ignored'), { recursive: true });
    await writeFile(path.join(workspace, 'ignored', 'Skip.ts'), '');
    await writeFile(path.join(workspace, '.gitignore'), 'ignored/\n');

    const entries = await new FileNameIndex().search('', {
      cwd: workspace,
      limit: 100,
      includeDirectories: true,
    });

    expect(entries.map((entry) => entry.path)).toEqual([
      'src/',
      'src/ExistingService.ts',
      'src/nested/',
      'src/nested/Deep.ts',
    ]);
  });

  it('ignores .gitignore files above the workspace', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'blade-file-name-parent-'));
    try {
      await writeFile(path.join(parent, '.gitignore'), '*\n');
      const project = path.join(parent, 'project');
      await mkdir(path.join(project, 'src'), { recursive: true });
      await writeFile(path.join(project, 'src', 'App.ts'), '');

      await expect(
        new FileNameIndex().search('', { cwd: project, limit: 10 })
      ).resolves.toMatchObject([{ path: 'src/App.ts', isDirectory: false }]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/services/file-name-index.test.ts`
Expected: the first new test fails because fast-glob also lists `empty/` (and in traversal order); the parent `.gitignore` test passes today (guard for `--no-ignore-parent`).

- [ ] **Step 3: Implement**

In `FileNameIndex.ts`, import `getExcludePatterns` alongside `FileFilter` and `listFilesWithRipgrep` from `../tools/builtin/search/ripgrep.js`. Split `buildSnapshot`:

```ts
  private async buildSnapshot(
    cwd: string,
    ignorePatterns: string[] | undefined
  ): Promise<FileNameIndexSnapshot> {
    const listed = await listFilesWithRipgrep({
      cwd,
      hidden: false,
      ignore: ignorePatterns ?? getExcludePatterns(),
    });
    const entries = listed
      ? withParentDirectories(listed)
      : await this.listWithFastGlob(cwd, ignorePatterns);
    const files = entries.filter((entry) => !entry.isDirectory);
    // …existing fuseOptions and return
  }

  private async listWithFastGlob(
    cwd: string,
    ignorePatterns: string[] | undefined
  ): Promise<FileNameIndexEntry[]> {
    // …existing FileFilter.create + fg('**/*', …) + map/filter body, returning the entries array
  }
```

and add below the class-independent types:

```ts
/** 由文件路径推导所有上级目录（以 / 结尾，与 fast-glob 的 markDirectories 一致），按路径排序 */
function withParentDirectories(files: string[]): FileNameIndexEntry[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (
      let index = file.indexOf('/');
      index !== -1;
      index = file.indexOf('/', index + 1)
    ) {
      directories.add(file.slice(0, index + 1));
    }
  }
  return [
    ...[...directories].map((path) => ({ path, isDirectory: true })),
    ...files.map((path) => ({ path, isDirectory: false })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `../../node_modules/.bin/vitest run --config vitest.config.ts --project unit tests/unit/services/file-name-index.test.ts tests/unit/tooling/tools/builtin/find-files.test.ts tests/unit/platform/ui/hooks/useAtCompletion.test.tsx`
Expected: all pass.

- [ ] **Step 5: Document FindFiles**

`docs/reference/tool-list.md` FindFiles features:

```markdown
**特性**: 基于共享的 workspace 文件名索引（优先用内置 ripgrep 列出文件，不可用时回退 fast-glob），遵循 `.gitignore` 和默认忽略规则；目录由文件路径推导，空目录不出现
```

`docs/en/reference/tool-list.md`:

```markdown
**Features**: Uses a shared workspace file-name index (listed with the bundled
ripgrep, falling back to fast-glob) that respects `.gitignore` and built-in
ignore rules; directories are derived from file paths, so empty directories are
not listed
```

---

### Task 5: Package-level verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks and suites**

From the repository root: `bun run type-check`, `bun run lint`, `node_modules/.bin/knip --no-progress`, `bun run build`, `bun run test:all`, `bun run test:web`. Expected: all exit 0.

- [ ] **Step 2: Packed CLI end to end**

`npm pack` in `packages/cli`, install the tarball into a temporary prefix with `--omit=optional --ignore-scripts`, remove every `rg` from `PATH`, and drive the installed CLI in headless mode with a fake OpenAI-compatible server that issues (1) a Grep call with pattern `foo(?=Bar)` and `-C 1`, then (2) a Glob call whose result depends on a `.gitignore` negation. Expected: `tool_progress` names `node_modules/blade-code/vendor/ripgrep/<platform>/rg`; the model receives the look-around match with its context, and the Glob result includes the negated file.
