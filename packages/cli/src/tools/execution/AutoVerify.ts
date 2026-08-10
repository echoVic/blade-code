import path from 'node:path';
import { isAcpMode } from '../../acp/AcpServiceContext.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { WorkspaceTrustService } from '../../security/WorkspaceTrustService.js';
import {
  type OwnedProcessTree,
  spawnOwnedProcess,
} from '../../utils/process/OwnedProcessTree.js';
import type { ExecutionContext, ToolResult } from '../types/index.js';
import {
  type VerificationCommandResult,
  type VerificationCommandRunner,
  VerifyQueue,
  type VerifyResult,
} from './VerifyQueue.js';

const logger = createLogger(LogCategory.EXECUTION);
const TRIGGER_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch']);
const MAX_ERROR_LINES = 15;
const MAX_STREAM_CHARS = 256 * 1024;

export interface AutoVerifyRuntimeOptions {
  sessionId: string;
  workspaceRoot: string;
  projectRoot: string;
  environment: Readonly<Record<string, string>>;
  resolveTrust?: () => Promise<boolean>;
  isRemoteSession?: () => boolean;
  runCommand?: VerificationCommandRunner;
}

interface ActiveCommand {
  processTree: OwnedProcessTree;
  settled: Promise<void>;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_STREAM_CHARS) return current;
  return current + chunk.slice(0, MAX_STREAM_CHARS - current.length);
}

function filterErrorsForFiles(output: string, filePaths: readonly string[]): string[] {
  const names = filePaths.map((filePath) => path.basename(filePath));
  const absolutePaths = filePaths.map((filePath) => path.resolve(filePath));
  return output
    .split('\n')
    .filter(
      (line) =>
        names.some((name) => line.includes(name)) ||
        absolutePaths.some((filePath) => line.includes(filePath))
    );
}

function extractVerificationFiles(
  params: Record<string, unknown>,
  result: ToolResult
): string[] {
  const direct = (params.file_path as string) || (params.path as string);
  if (direct) return [direct];
  if (!Array.isArray(result.metadata?.changes)) return [];
  return [
    ...new Set(
      result.metadata.changes
        .filter((change): change is { path: string; newContent?: unknown } =>
          Boolean(
            change &&
              typeof change === 'object' &&
              'path' in change &&
              typeof change.path === 'string' &&
              (!('newContent' in change) || change.newContent !== null)
          )
        )
        .map((change) => change.path)
    ),
  ];
}

/**
 * Session-owned post-edit diagnostics.
 *
 * Project scripts are executable repository content. They are only eligible
 * after an explicit Workspace Trust decision and when the caller already
 * selected YOLO execution. ACP files are remote-owned and never verified by a
 * local process.
 */
export class AutoVerifyRuntime {
  private readonly verifyQueue: VerifyQueue;
  private readonly activeCommands = new Set<ActiveCommand>();
  private readonly activeVerifications = new Set<Promise<void>>();
  private readonly disposeController = new AbortController();
  private disposed = false;

  constructor(private readonly options: AutoVerifyRuntimeOptions) {
    this.verifyQueue = new VerifyQueue({
      runCommand:
        options.runCommand ??
        ((command, args, cwd, timeoutMs, signal) =>
          this.runOwnedCommand(command, args, cwd, timeoutMs, signal)),
    });
  }

  verify(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolResult
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const verification = this.verifyInternal(toolName, params, context, result).finally(
      () => {
        this.activeVerifications.delete(verification);
      }
    );
    this.activeVerifications.add(verification);
    return verification;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();

    const activeCommands = [...this.activeCommands];
    const activeVerifications = [...this.activeVerifications];
    await Promise.allSettled(
      activeCommands.map((entry) => entry.processTree.terminate())
    );
    await Promise.allSettled(activeCommands.map((entry) => entry.settled));
    await Promise.allSettled(activeVerifications);
    this.activeCommands.clear();
    this.activeVerifications.clear();
    this.verifyQueue.clearCache();
  }

  private async verifyInternal(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolResult
  ): Promise<void> {
    if (
      this.disposed ||
      !TRIGGER_TOOLS.has(toolName) ||
      !result.success ||
      this.isRemoteSession()
    ) {
      return;
    }

    const filePaths = extractVerificationFiles(params, result);
    if (filePaths.length === 0 || !(await this.isProjectExplicitlyTrusted())) return;
    const absoluteFilePaths = filePaths
      .map((filePath) =>
        path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.resolve(this.options.workspaceRoot, filePath)
      )
      .filter((filePath) => {
        const relative = path.relative(this.options.workspaceRoot, filePath);
        return (
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
    if (absoluteFilePaths.length === 0) return;

    let verification: VerifyResult | null;
    try {
      const signal = context.signal
        ? AbortSignal.any([context.signal, this.disposeController.signal])
        : this.disposeController.signal;
      verification = await this.verifyQueue.verify(
        absoluteFilePaths[0],
        this.options.workspaceRoot,
        signal
      );
    } catch (error) {
      if (!context.signal?.aborted && !this.disposeController.signal.aborted) {
        logger.debug(
          `[AutoVerify] type-check failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return;
    }
    if (!verification || verification.timedOut || !verification.hasErrors) return;

    const relevantErrors = filterErrorsForFiles(
      verification.rawOutput,
      absoluteFilePaths
    );
    if (relevantErrors.length === 0) return;

    const truncated = relevantErrors.slice(0, MAX_ERROR_LINES);
    const diagnostics =
      `Type errors:\n${truncated.join('\n')}` +
      (relevantErrors.length > MAX_ERROR_LINES
        ? `\n... (+${relevantErrors.length - MAX_ERROR_LINES} more)`
        : '');
    const currentContent =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : result.llmContent
          ? JSON.stringify(result.llmContent)
          : '';
    result.llmContent =
      `${currentContent}\n\n---\n` +
      `**Auto-Verify: issues after ${
        absoluteFilePaths.length === 1
          ? path.basename(absoluteFilePaths[0])
          : `${absoluteFilePaths.length} patched files`
      }:**\n` +
      `\`\`\`\n${diagnostics}\n\`\`\``;

    logger.info(
      `[AutoVerify] injected type diagnostics (${absoluteFilePaths.length} files)`
    );
  }

  private isRemoteSession(): boolean {
    return this.options.isRemoteSession?.() ?? isAcpMode(this.options.sessionId);
  }

  private async isProjectExplicitlyTrusted(): Promise<boolean> {
    if (this.options.resolveTrust) return this.options.resolveTrust();
    const status = await WorkspaceTrustService.getInstance().getStatus(
      this.options.projectRoot
    );
    return status.state === 'trusted';
  }

  private runOwnedCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    turnSignal?: AbortSignal
  ): Promise<VerificationCommandResult> {
    if (this.disposed || turnSignal?.aborted) {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: false,
      });
    }

    const { child, processTree } = spawnOwnedProcess(command, args, {
      cwd,
      env: {
        ...this.options.environment,
        PATH: this.options.environment.PATH ?? process.env.PATH ?? '',
        HOME: this.options.environment.HOME ?? process.env.HOME ?? '',
        USER: this.options.environment.USER ?? process.env.USER ?? '',
        SHELL: this.options.environment.SHELL ?? process.env.SHELL ?? '/bin/sh',
        BLADE_CLI: '1',
        BLADE_SESSION_ID: this.options.sessionId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settleActive!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const active: ActiveCommand = { processTree, settled };
    this.activeCommands.add(active);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let completed = false;
      let termination: ReturnType<OwnedProcessTree['terminate']> | undefined;
      const terminate = () => {
        termination ??= processTree.terminate();
        return termination;
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendBounded(stderr, chunk);
      });

      const cleanup = () => {
        clearTimeout(timer);
        turnSignal?.removeEventListener('abort', abort);
        this.disposeController.signal.removeEventListener('abort', abort);
        this.activeCommands.delete(active);
        settleActive();
      };
      const abort = () => {
        void terminate();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, timeoutMs);

      turnSignal?.addEventListener('abort', abort, { once: true });
      this.disposeController.signal.addEventListener('abort', abort, {
        once: true,
      });
      if (turnSignal?.aborted || this.disposeController.signal.aborted) {
        abort();
      }

      child.once('error', (error) => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(error);
      });
      child.once('close', async (code) => {
        if (completed) return;
        completed = true;
        if (timedOut || turnSignal?.aborted || this.disposeController.signal.aborted) {
          await terminate();
        }
        cleanup();
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          timedOut,
        });
      });
    });
  }
}
