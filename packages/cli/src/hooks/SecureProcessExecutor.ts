/**
 * Secure Process Executor
 *
 * 安全地执行 Hook 子进程
 */

import { spawnOwnedProcess } from '../utils/process/OwnedProcessTree.js';
import type {
  HookExecutionContext,
  HookExitCode,
  HookInput,
  ProcessResult,
} from './types/HookTypes.js';

/**
 * 流量限制器
 */
class StreamLimiter {
  private content = '';
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  append(data: string): void {
    if (this.content.length < this.maxSize) {
      const remaining = this.maxSize - this.content.length;
      this.content += data.substring(0, remaining);
    }
  }

  getContent(): string {
    return this.content;
  }

  isFull(): boolean {
    return this.content.length >= this.maxSize;
  }
}

/**
 * 安全进程执行器
 */
export class SecureProcessExecutor {
  private readonly MAX_STDOUT_SIZE = 1 * 1024 * 1024; // 1MB
  private readonly MAX_STDERR_SIZE = 1 * 1024 * 1024; // 1MB
  private readonly MAX_INPUT_SIZE = 100 * 1024; // 100KB

  /**
   * 执行命令
   */
  async execute(
    command: string,
    input: HookInput,
    context: HookExecutionContext,
    timeoutMs: number
  ): Promise<ProcessResult> {
    // 1. 验证输入大小
    const inputJson = JSON.stringify(input);
    if (inputJson.length > this.MAX_INPUT_SIZE) {
      throw new Error(
        `Hook input too large: ${inputJson.length} bytes (max ${this.MAX_INPUT_SIZE})`
      );
    }

    // 2. 创建受限环境变量
    const env = this.createSafeEnv(input);

    // 3. 启动子进程
    const { child, processTree } = spawnOwnedProcess(command, [], {
      shell: true,
      env,
      cwd: context.projectDir,
    });

    // 4. 流量控制
    const stdout = new StreamLimiter(this.MAX_STDOUT_SIZE);
    const stderr = new StreamLimiter(this.MAX_STDERR_SIZE);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (data: string) => {
      stdout.append(data);
    });

    child.stderr?.on('data', (data: string) => {
      stderr.append(data);
    });

    // 5. 写入输入
    try {
      child.stdin?.write(inputJson);
      child.stdin?.end();
    } catch (err) {
      await processTree.terminate();
      throw new Error(`Failed to write hook input: ${err}`);
    }

    // 6. 等待完成或超时
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let resolved = false;
      let terminationPromise: ReturnType<typeof processTree.terminate> | undefined;

      const terminate = () => {
        terminationPromise ??= processTree.terminate();
        return terminationPromise;
      };

      // 保存 abort handler 引用，以便后续移除
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        // 移除 abort 监听器，避免内存泄漏
        if (abortHandler && context.abortSignal) {
          context.abortSignal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, timeoutMs);

      child.on('close', async (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        if (timedOut) await terminate();

        resolve({
          stdout: stdout.getContent(),
          stderr: stderr.getContent(),
          exitCode: timedOut ? (124 as HookExitCode) : (code ?? 1),
          timedOut,
        });
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      });

      // 处理中止信号
      if (context.abortSignal) {
        abortHandler = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          cleanup();
          void terminate().then(() => {
            resolve({
              stdout: stdout.getContent(),
              stderr: 'Hook cancelled by abort signal',
              exitCode: 1,
              timedOut: false,
            });
          });
        };
        context.abortSignal.addEventListener('abort', abortHandler);
        if (context.abortSignal.aborted) abortHandler();
      }
    });
  }

  /**
   * 创建安全的环境变量
   */
  private createSafeEnv(input: HookInput): NodeJS.ProcessEnv {
    // 只暴露安全的环境变量
    return {
      // Blade 特定变量
      BLADE_PROJECT_DIR: input.project_dir,
      BLADE_SESSION_ID: input.session_id,
      BLADE_HOOK_EVENT: input.hook_event_name,
      BLADE_TOOL_NAME: 'tool_name' in input ? (input.tool_name as string) : '',
      BLADE_TOOL_USE_ID: 'tool_use_id' in input ? (input.tool_use_id as string) : '',

      // 保留必要的系统变量
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      USER: process.env.USER || '',
      SHELL: process.env.SHELL || '/bin/sh',

      // 不传递敏感变量 (API keys, tokens, etc.)
    };
  }
}
