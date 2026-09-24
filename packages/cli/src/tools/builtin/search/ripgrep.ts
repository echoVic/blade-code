import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import picomatch from 'picomatch';
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
