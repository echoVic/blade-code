import { mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { Mutex } from 'async-mutex';
import { getBladeStorageRoot } from '../../../context/storage/pathUtils.js';
import { PathSecurity } from '../../../utils/pathSecurity.js';

export interface WorkspaceSandboxInput {
  command: string;
  cwd: string;
  workspaceRoot: string;
  access?: 'workspace-write' | 'workspace-read-only';
  signal?: AbortSignal;
}

export interface SandboxedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: true;
  inheritProcessEnv?: boolean;
  cleanup: () => void;
}

export interface WorkspaceSandboxBackend {
  prepare(input: WorkspaceSandboxInput): Promise<SandboxedCommand>;
}

interface SandboxDependencyCheck {
  errors: string[];
  warnings: string[];
}

export interface WorkspaceSandboxRuntime {
  isSupportedPlatform(): Promise<boolean>;
  checkDependencies(): Promise<SandboxDependencyCheck>;
  getDefaultWritePaths(): Promise<string[]>;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

interface AnthropicWorkspaceSandboxOptions {
  runtime?: WorkspaceSandboxRuntime;
  tempRoot?: string;
  defaultWritePaths?: string[];
}

const sandboxWrapMutex = new Mutex();

let loadedRuntime: Awaited<ReturnType<typeof importSandboxRuntime>> | undefined;
let runtimeLoading: ReturnType<typeof importSandboxRuntime> | undefined;

function importSandboxRuntime() {
  return import('@anthropic-ai/sandbox-runtime');
}

async function loadSandboxRuntime() {
  if (loadedRuntime) return loadedRuntime;
  if (!runtimeLoading) {
    runtimeLoading = importSandboxRuntime();
  }
  loadedRuntime = await runtimeLoading;
  return loadedRuntime;
}

const runtimeAdapter: WorkspaceSandboxRuntime = {
  isSupportedPlatform: async () =>
    (await loadSandboxRuntime()).SandboxManager.isSupportedPlatform(),
  checkDependencies: async () =>
    (await loadSandboxRuntime()).SandboxManager.checkDependencies(),
  getDefaultWritePaths: async () => (await loadSandboxRuntime()).getDefaultWritePaths(),
  initialize: async (config) =>
    (await loadSandboxRuntime()).SandboxManager.initialize(config),
  updateConfig: (config) => {
    if (!loadedRuntime) throw new Error('Sandbox runtime is not initialized');
    loadedRuntime.SandboxManager.updateConfig(config);
  },
  wrapWithSandboxArgv: async (command, binShell, customConfig, signal, cwd) =>
    (await loadSandboxRuntime()).SandboxManager.wrapWithSandboxArgv(
      command,
      binShell,
      customConfig,
      signal,
      cwd
    ),
  cleanupAfterCommand: () => loadedRuntime?.SandboxManager.cleanupAfterCommand(),
  reset: async () => {
    await loadedRuntime?.SandboxManager.reset();
  },
};

function createSandboxRuntimeConfig(allowedDomains: string[]): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    },
    enableWeakerNestedSandbox: true,
  };
}

export class WorkspaceSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSandboxUnavailableError';
  }
}

export class WorkspaceSandboxBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSandboxBoundaryError';
  }
}

export class WorkspaceWriteSandbox {
  constructor(private readonly backend: WorkspaceSandboxBackend) {}

  async prepare(input: WorkspaceSandboxInput): Promise<SandboxedCommand> {
    const requestedWorkspace = path.resolve(input.workspaceRoot);
    const requestedCwd = path.resolve(input.cwd);
    if (!PathSecurity.isWithinWorkspace(requestedCwd, requestedWorkspace)) {
      throw new WorkspaceSandboxBoundaryError(
        `Bash cwd is outside the workspace sandbox: ${input.cwd}`
      );
    }

    let workspaceRoot: string;
    let cwd: string;
    try {
      [workspaceRoot, cwd] = await Promise.all([
        realpath(requestedWorkspace),
        realpath(requestedCwd),
      ]);
    } catch (error) {
      throw new WorkspaceSandboxBoundaryError(
        `Workspace sandbox path cannot be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!PathSecurity.isWithinWorkspace(cwd, workspaceRoot)) {
      throw new WorkspaceSandboxBoundaryError(
        `Bash cwd resolves outside the workspace sandbox: ${input.cwd}`
      );
    }

    return this.backend.prepare({
      ...input,
      cwd,
      workspaceRoot,
    });
  }
}

export class AnthropicWorkspaceSandboxBackend implements WorkspaceSandboxBackend {
  private readonly runtime: WorkspaceSandboxRuntime;
  private readonly tempRoot: string;
  private readonly defaultWritePaths?: string[];
  private initialization?: Promise<void>;

  constructor(options: AnthropicWorkspaceSandboxOptions = {}) {
    this.runtime = options.runtime ?? runtimeAdapter;
    this.tempRoot = options.tempRoot ?? path.join(getBladeStorageRoot(), 'sandbox-tmp');
    this.defaultWritePaths = options.defaultWritePaths;
  }

  async prepare(input: WorkspaceSandboxInput): Promise<SandboxedCommand> {
    await this.ensureInitialized();
    const tempRoot = await this.prepareTempRoot();
    const tmpDir = path.join(tempRoot, 'tmp');
    const cacheDir = path.join(tempRoot, 'cache');
    const npmCacheDir = path.join(cacheDir, 'npm');
    const bunCacheDir = path.join(cacheDir, 'bun');
    await Promise.all([
      mkdir(tmpDir, { recursive: true }),
      mkdir(npmCacheDir, { recursive: true }),
      mkdir(bunCacheDir, { recursive: true }),
    ]);

    const defaultWritePaths =
      this.defaultWritePaths ?? (await this.runtime.getDefaultWritePaths());
    const deniedDefaultPaths = defaultWritePaths.filter(
      (candidate) => !candidate.startsWith('/dev/')
    );
    const workspaceReadOnly = input.access === 'workspace-read-only';
    const deniedReadPaths = workspaceReadOnly
      ? [
          os.homedir(),
          getBladeStorageRoot(),
          process.env.BLADE_REAL_API_CREDENTIALS_FILE,
        ]
          .filter(
            (candidate): candidate is string =>
              typeof candidate === 'string' && candidate.trim().length > 0
          )
          .map((candidate) => path.resolve(candidate))
          .filter((candidate, index, values) => values.indexOf(candidate) === index)
      : [];
    const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
    let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
    let releaseNetworkFence: (() => void) | undefined;
    const restoreNetworkAndRelease = () => {
      if (!releaseNetworkFence) return;
      const release = releaseNetworkFence;
      releaseNetworkFence = undefined;
      try {
        this.runtime.updateConfig(createSandboxRuntimeConfig(['*']));
      } finally {
        release();
      }
    };
    const wrap = async () => {
      const previousTmpDir = process.env.CLAUDE_CODE_TMPDIR;
      process.env.CLAUDE_CODE_TMPDIR = tmpDir;
      try {
        return await this.runtime.wrapWithSandboxArgv(
          input.command,
          shell,
          {
            network: workspaceReadOnly
              ? {
                  allowedDomains: [],
                  deniedDomains: [],
                  strictAllowlist: true,
                }
              : {
                  allowedDomains: ['*'],
                  deniedDomains: [],
                  strictAllowlist: true,
                },
            filesystem: {
              denyRead: deniedReadPaths,
              allowRead: workspaceReadOnly ? [input.workspaceRoot] : [],
              allowWrite: workspaceReadOnly
                ? [tempRoot]
                : [input.workspaceRoot, tempRoot],
              denyWrite: workspaceReadOnly
                ? [input.workspaceRoot, ...deniedDefaultPaths]
                : deniedDefaultPaths,
            },
            git: {
              safeDirectories: [input.workspaceRoot],
            },
          },
          input.signal,
          input.cwd
        );
      } finally {
        if (previousTmpDir === undefined) {
          delete process.env.CLAUDE_CODE_TMPDIR;
        } else {
          process.env.CLAUDE_CODE_TMPDIR = previousTmpDir;
        }
      }
    };
    try {
      if (workspaceReadOnly) {
        releaseNetworkFence = await sandboxWrapMutex.acquire();
        this.runtime.updateConfig(createSandboxRuntimeConfig([]));
        wrapped = await wrap();
      } else {
        wrapped = await sandboxWrapMutex.runExclusive(wrap);
      }
    } catch (error) {
      restoreNetworkAndRelease();
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new WorkspaceSandboxUnavailableError(
        `Workspace sandbox failed to prepare the command: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    let cleaned = false;
    return {
      executable: wrapped.argv[0] ?? shell,
      args: wrapped.argv.slice(1),
      env: {
        ...wrapped.env,
        TMPDIR: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        XDG_CACHE_HOME: cacheDir,
        npm_config_cache: npmCacheDir,
        BUN_INSTALL_CACHE_DIR: bunCacheDir,
      },
      sandboxed: true,
      inheritProcessEnv: !workspaceReadOnly,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          this.runtime.cleanupAfterCommand();
        } finally {
          restoreNetworkAndRelease();
        }
      },
    };
  }

  async dispose(): Promise<void> {
    this.initialization = undefined;
    await this.runtime.reset();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeRuntime().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeRuntime(): Promise<void> {
    if (!(await this.runtime.isSupportedPlatform())) {
      throw new WorkspaceSandboxUnavailableError(
        `Workspace sandbox is unsupported on ${process.platform}`
      );
    }

    const dependencyCheck = await this.runtime.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      throw new WorkspaceSandboxUnavailableError(
        `Workspace sandbox dependencies are unavailable: ${dependencyCheck.errors.join(
          '; '
        )}`
      );
    }

    try {
      await this.runtime.initialize(createSandboxRuntimeConfig(['*']));
    } catch (error) {
      throw new WorkspaceSandboxUnavailableError(
        `Workspace sandbox failed to initialize: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async prepareTempRoot(): Promise<string> {
    await mkdir(this.tempRoot, { recursive: true });
    return realpath(this.tempRoot);
  }
}

export function isWorkspaceSandboxRuntimeFailure(
  exitCode: number | null,
  stderr: string
): boolean {
  const message = stderr.toLowerCase();
  return (
    (exitCode === 71 && message.includes('sandbox-exec')) ||
    message.includes('sandbox_apply: operation not permitted') ||
    message.includes('bwrap: creating new namespace failed') ||
    message.includes('failed to create new user namespace') ||
    message.includes('srt-win sandbox failed')
  );
}

let activeBackend: WorkspaceSandboxBackend = new AnthropicWorkspaceSandboxBackend();
const delegatingBackend: WorkspaceSandboxBackend = {
  prepare: (input) => activeBackend.prepare(input),
};

export const workspaceWriteSandbox = new WorkspaceWriteSandbox(delegatingBackend);

export function installWorkspaceSandboxBackendForTests(
  backend: WorkspaceSandboxBackend
): () => void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Workspace sandbox test backends require NODE_ENV=test');
  }
  const previous = activeBackend;
  activeBackend = backend;
  return () => {
    if (activeBackend === backend) {
      activeBackend = previous;
    }
  };
}
