/**
 * VerifyQueue — AutoVerify 的并发合并 + 短期缓存层
 *
 * 问题:
 * Agent 连续多次 Edit 会触发多次 tsc 全量扫描,重复工作且互相推迟。
 *
 * 对策:
 * 1. **并发合并**: 同 workspace、同文件版本的 verify 请求共享一个 tsc Promise
 * 2. **短期缓存**: 最近 500ms 内且输入未变化的结果可复用
 * 3. **变更排队**: 检查运行中再次编辑时，在旧检查结束后验证最新输入
 * 4. **增量 tsc**: 自动追加 --incremental + tsBuildInfoFile
 * 5. **Monorepo 感知**: workspace = 从文件向上找最近 tsconfig.json
 *
 * 不做:
 * - 不做 debounce 延迟 (调用方期望立即��到结果; agent 下一步才能消费)
 * - 不改写同步接口 (仍 await)
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger, LogCategory } from '../../logging/Logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger(LogCategory.EXECUTION);

export interface VerifyResult {
  /** 是否有类型错误 (typecheck exit code != 0) */
  hasErrors: boolean;
  /** 完整 tsc 输出 (stdout + stderr) */
  rawOutput: string;
  /** 是否超时 */
  timedOut: boolean;
  /** 解析到的 workspace 根绝对路径 */
  workspaceRoot: string;
}

export interface VerifyQueueOptions {
  /** 缓存新鲜度 (ms), 默认 500 */
  cacheMs?: number;
  /** tsc 超时 (ms), 默认 10_000 */
  timeoutMs?: number;
  /** 覆盖命令 (测试用) */
  runCommand?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
}

interface CacheEntry {
  result: VerifyResult;
  at: number;
  inputFingerprint: string;
}

interface RunningEntry {
  inputFingerprint: string;
  promise: Promise<VerifyResult>;
}

export class VerifyQueue {
  private static instance: VerifyQueue | null = null;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly runCommand: NonNullable<VerifyQueueOptions['runCommand']>;

  private running = new Map<string, RunningEntry>();
  private cache = new Map<string, CacheEntry>();

  constructor(options: VerifyQueueOptions = {}) {
    this.cacheMs = options.cacheMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  static getInstance(): VerifyQueue {
    if (!VerifyQueue.instance) {
      VerifyQueue.instance = new VerifyQueue();
    }
    return VerifyQueue.instance;
  }

  /** 仅用于测试 */
  static resetInstance(): void {
    VerifyQueue.instance = null;
  }

  /**
   * 对文件所属的 workspace 跑类型检查
   * - 并发合并: 同 workspace 且输入 fingerprint 相同 → 共享
   * - 变更排队: 同 workspace 但输入不同 → 等待当前检查后重新执行
   * - 缓存窗口: 最近 cacheMs 内且输入相同 → 直接复用
   *
   * @returns VerifyResult; 若检测不到类型检查环境 → null
   */
  async verify(filePath: string, searchRoot: string): Promise<VerifyResult | null> {
    const workspace = resolveWorkspaceRoot(filePath, searchRoot);
    if (!workspace) return null;

    const now = Date.now();
    const inputFingerprint = getInputFingerprint(filePath, searchRoot);
    const cached = this.cache.get(workspace);
    if (
      cached &&
      cached.inputFingerprint === inputFingerprint &&
      now - cached.at < this.cacheMs
    ) {
      logger.debug(`[VerifyQueue] cache hit: ${workspace}`);
      return cached.result;
    }

    const running = this.running.get(workspace);
    if (running?.inputFingerprint === inputFingerprint) {
      logger.debug(`[VerifyQueue] coalescing into running check: ${workspace}`);
      return running.promise;
    }

    const run = async (): Promise<VerifyResult> => {
      const result = await this.runTypeCheck(workspace);
      this.cache.set(workspace, {
        result,
        at: Date.now(),
        inputFingerprint,
      });
      return result;
    };
    const previous = running?.promise;
    const pending = (previous ? previous.then(run, run) : run()).finally(() => {
      if (this.running.get(workspace)?.promise === pending) {
        this.running.delete(workspace);
      }
    });
    const entry: RunningEntry = {
      inputFingerprint,
      promise: pending,
    };
    this.running.set(workspace, entry);
    return pending;
  }

  /** 手动清空缓存 (测试用) */
  clearCache(): void {
    this.cache.clear();
  }

  private async runTypeCheck(workspaceRoot: string): Promise<VerifyResult> {
    const { cmd, args } = buildTypeCheckArgs(workspaceRoot);
    logger.debug(`[VerifyQueue] running: ${cmd} ${args.join(' ')} in ${workspaceRoot}`);
    const { stdout, stderr, exitCode, timedOut } = await this.runCommand(
      cmd,
      args,
      workspaceRoot,
      this.timeoutMs
    );

    const rawOutput = `${stdout}\n${stderr}`.trim();
    return {
      hasErrors: exitCode !== 0 && !timedOut,
      rawOutput,
      timedOut,
      workspaceRoot,
    };
  }
}

function getInputFingerprint(filePath: string, searchRoot: string): string {
  const absPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(searchRoot, filePath);

  try {
    const digest = createHash('sha256').update(readFileSync(absPath)).digest('hex');
    return `${absPath}\0${digest}`;
  } catch {
    return `${absPath}\0missing`;
  }
}

/**
 * 从文件路径向上找 workspace 根 (含 tsconfig.json)。
 * Monorepo 场景: 优先匹配最近的 tsconfig.json,若找不到则退到 searchRoot (若 searchRoot 有 tsconfig)。
 */
export function resolveWorkspaceRoot(
  filePath: string,
  searchRoot: string
): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(searchRoot, filePath);
  let dir = path.dirname(abs);
  const stopAt = path.parse(dir).root;

  while (dir !== stopAt) {
    if (existsSync(path.join(dir, 'tsconfig.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  if (existsSync(path.join(searchRoot, 'tsconfig.json'))) {
    return searchRoot;
  }
  return null;
}

/**
 * 构建类型检查命令。
 *
 * 策略:
 * 1. 若 workspace 有 package.json 且有 scripts.type-check → `bun run type-check`
 *    (用户配置的命令,尊重其约定;由用户自己决定 --incremental)
 * 2. 否则 `npx tsc --noEmit --incremental --tsBuildInfoFile .blade-tsbuildinfo`
 *    (增量缓存文件固定,避免与项目自己的 buildInfo 冲突)
 */
export function buildTypeCheckArgs(workspaceRoot: string): {
  cmd: string;
  args: string[];
} {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(pkgPath);
      if (pkg?.scripts?.['type-check']) {
        return { cmd: 'bun', args: ['run', 'type-check'] };
      }
    } catch {
      // ignore
    }
  }

  return {
    cmd: 'npx',
    args: [
      'tsc',
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      '.blade-tsbuildinfo',
    ],
  };
}

async function defaultRunCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0, timedOut: false };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode,
      timedOut,
    };
  }
}
