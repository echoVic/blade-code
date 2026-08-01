import { type ExecFileException, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { basename, isAbsolute, join, relative, resolve } from 'pathe';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';

const MAX_WORKTREE_NAME_LENGTH = 64;
const VALID_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeSession {
  sessionId: string;
  name: string;
  branch: string;
  baseCommit: string;
  originalBranch: string;
  repositoryRoot: string;
  originalWorkspaceRoot: string;
  worktreeRoot: string;
  workspaceRoot: string;
  sourceHadChanges: boolean;
}

export interface WorktreeExitResult {
  action: 'keep' | 'remove';
  workspaceRoot: string;
  worktreeRoot?: string;
  branch?: string;
  removed: boolean;
  noop?: boolean;
  discardedFiles?: number;
  discardedCommits?: number;
}

export interface WorktreeChangeSummary {
  changedFiles: number;
  commits: number;
}

interface WorktreeManagerOptions {
  storageRoot?: string;
}

interface EnterWorktreeInput {
  sessionId: string;
  workspaceRoot: string;
  name?: string;
}

interface ExitWorktreeInput {
  sessionId: string;
  action: 'keep' | 'remove';
  discardChanges?: boolean;
  workspaceRoot?: string;
}

export function validateWorktreeName(name: string): void {
  if (!name || name.length > MAX_WORKTREE_NAME_LENGTH) {
    throw new Error(
      `Worktree name must contain 1-${MAX_WORKTREE_NAME_LENGTH} characters`
    );
  }

  for (const segment of name.split('/')) {
    if (segment === '.' || segment === '..' || !VALID_NAME_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${name}": use letters, digits, dots, underscores, dashes, and optional "/" separators`
      );
    }
  }
}

function shortHash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function flattenName(name: string): string {
  return name.replaceAll('/', '+');
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
        },
      },
      (error: ExecFileException | null, stdout, stderr) => {
        resolvePromise({
          code: error == null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      }
    );
  });
}

function requireGitSuccess(result: GitResult, operation: string): string {
  if (result.code !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr.trim() || result.stdout.trim() || 'unknown git error'}`
    );
  }
  return result.stdout.trim();
}

export class WorktreeManager {
  private readonly storageRoot: string;
  private readonly sessions = new Map<string, WorktreeSession>();
  private readonly sessionLocks = new Map<string, Mutex>();

  constructor(options: WorktreeManagerOptions = {}) {
    this.storageRoot = options.storageRoot ?? getBladeStorageRoot();
  }

  getActiveSession(sessionId: string): WorktreeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getManagedRoot(repositoryRoot: string): string {
    const normalizedRoot = resolve(repositoryRoot);
    const repositoryKey = `${basename(normalizedRoot)}-${shortHash(normalizedRoot)}`;
    return join(this.storageRoot, 'worktrees', repositoryKey);
  }

  async enter(input: EnterWorktreeInput): Promise<WorktreeSession> {
    return this.getSessionLock(input.sessionId).runExclusive(async () => {
      if (this.sessions.has(input.sessionId)) {
        throw new Error('This session is already inside a managed worktree');
      }

      const requestedWorkspaceRoot = resolve(input.workspaceRoot);
      const rootResult = await runGit(requestedWorkspaceRoot, [
        'rev-parse',
        '--show-toplevel',
      ]);
      const [originalWorkspaceRoot, repositoryRoot] = await Promise.all([
        realpath(requestedWorkspaceRoot),
        realpath(requireGitSuccess(rootResult, 'Resolve repository root')),
      ]);
      const subdirectory = relative(repositoryRoot, originalWorkspaceRoot);
      if (
        subdirectory === '..' ||
        subdirectory.startsWith('../') ||
        isAbsolute(subdirectory)
      ) {
        throw new Error('Workspace is outside the resolved git repository');
      }

      const name =
        input.name ??
        `session-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      validateWorktreeName(name);

      const [baseCommitResult, branchResult, statusResult] = await Promise.all([
        runGit(repositoryRoot, ['rev-parse', 'HEAD']),
        runGit(repositoryRoot, ['branch', '--show-current']),
        runGit(repositoryRoot, ['status', '--porcelain']),
      ]);
      const baseCommit = requireGitSuccess(
        baseCommitResult,
        'Resolve worktree base commit'
      );
      const originalBranch = requireGitSuccess(branchResult, 'Resolve current branch');
      requireGitSuccess(statusResult, 'Inspect source worktree');

      const flattenedName = flattenName(name);
      const branch = `blade-worktree-${flattenedName}-${shortHash(input.sessionId, 8)}`;
      const managedRoot = this.getManagedRoot(repositoryRoot);
      const worktreeRoot = join(managedRoot, flattenedName);
      await mkdir(managedRoot, { recursive: true });

      const createResult = await runGit(repositoryRoot, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreeRoot,
        baseCommit,
      ]);
      requireGitSuccess(createResult, 'Create worktree');

      const session: WorktreeSession = {
        sessionId: input.sessionId,
        name,
        branch,
        baseCommit,
        originalBranch,
        repositoryRoot,
        originalWorkspaceRoot,
        worktreeRoot,
        workspaceRoot: subdirectory ? join(worktreeRoot, subdirectory) : worktreeRoot,
        sourceHadChanges: statusResult.stdout.trim().length > 0,
      };
      this.sessions.set(input.sessionId, session);
      return session;
    });
  }

  async restoreSession(session: WorktreeSession): Promise<WorktreeSession> {
    return this.getSessionLock(session.sessionId).runExclusive(async () => {
      const existing = this.sessions.get(session.sessionId);
      if (existing) {
        return existing;
      }

      validateWorktreeName(session.name);
      const [worktreeRoot, workspaceRoot, repositoryRoot] = await Promise.all([
        realpath(session.worktreeRoot),
        realpath(session.workspaceRoot),
        realpath(session.repositoryRoot),
      ]);
      const [resolvedRootResult, branchResult, baseResult, listResult] =
        await Promise.all([
          runGit(worktreeRoot, ['rev-parse', '--show-toplevel']),
          runGit(worktreeRoot, ['branch', '--show-current']),
          runGit(worktreeRoot, ['cat-file', '-e', `${session.baseCommit}^{commit}`]),
          runGit(repositoryRoot, ['worktree', 'list', '--porcelain']),
        ]);
      const resolvedRoot = await realpath(
        requireGitSuccess(resolvedRootResult, 'Resolve restored worktree')
      );
      const branch = requireGitSuccess(branchResult, 'Resolve restored branch');
      requireGitSuccess(baseResult, 'Resolve restored base commit');
      requireGitSuccess(listResult, 'List restored worktrees');

      if (resolvedRoot !== worktreeRoot || branch !== session.branch) {
        throw new Error('Persisted worktree metadata does not match Git state');
      }
      const registeredPaths = listResult.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
      if (!registeredPaths.includes(worktreeRoot)) {
        throw new Error('Persisted worktree is no longer registered');
      }

      const restored: WorktreeSession = {
        ...session,
        repositoryRoot,
        worktreeRoot,
        workspaceRoot,
      };
      this.sessions.set(session.sessionId, restored);
      return restored;
    });
  }

  async getChangeSummary(
    sessionId: string
  ): Promise<WorktreeChangeSummary | null | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return this.inspectChanges(session);
  }

  async exit(input: ExitWorktreeInput): Promise<WorktreeExitResult> {
    return this.getSessionLock(input.sessionId).runExclusive(async () => {
      const session = this.sessions.get(input.sessionId);
      if (!session) {
        return {
          action: input.action,
          workspaceRoot: input.workspaceRoot ?? '',
          removed: false,
          noop: true,
        };
      }

      if (input.action === 'keep') {
        this.sessions.delete(input.sessionId);
        return {
          action: 'keep',
          workspaceRoot: session.originalWorkspaceRoot,
          worktreeRoot: session.worktreeRoot,
          branch: session.branch,
          removed: false,
        };
      }

      const changeSummary = await this.inspectChanges(session);
      if (!changeSummary && !input.discardChanges) {
        throw new Error(
          'Could not verify worktree state. Refusing removal without discard_changes=true'
        );
      }

      const { changedFiles, commits } = changeSummary ?? {
        changedFiles: 0,
        commits: 0,
      };
      if (!input.discardChanges && (changedFiles > 0 || commits > 0)) {
        const details = [
          changedFiles > 0
            ? `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`
            : '',
          commits > 0
            ? `${commits} unmerged ${commits === 1 ? 'commit' : 'commits'}`
            : '',
        ].filter(Boolean);
        throw new Error(
          `Worktree has ${details.join(' and ')}. Use action="keep" or confirm discard_changes=true`
        );
      }

      const removeArgs = ['worktree', 'remove'];
      if (input.discardChanges) {
        removeArgs.push('--force');
      }
      removeArgs.push(session.worktreeRoot);
      const removeResult = await runGit(session.repositoryRoot, removeArgs);
      requireGitSuccess(removeResult, 'Remove worktree');

      const branchResult = await runGit(session.repositoryRoot, [
        'branch',
        '-D',
        session.branch,
      ]);
      this.sessions.delete(input.sessionId);
      requireGitSuccess(branchResult, 'Delete worktree branch');

      return {
        action: 'remove',
        workspaceRoot: session.originalWorkspaceRoot,
        worktreeRoot: session.worktreeRoot,
        branch: session.branch,
        removed: true,
        discardedFiles: input.discardChanges ? changedFiles : undefined,
        discardedCommits: input.discardChanges ? commits : undefined,
      };
    });
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getSessionLock(sessionId: string): Mutex {
    let lock = this.sessionLocks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.sessionLocks.set(sessionId, lock);
    }
    return lock;
  }

  private async inspectChanges(
    session: WorktreeSession
  ): Promise<WorktreeChangeSummary | null> {
    const [statusResult, commitsResult] = await Promise.all([
      runGit(session.worktreeRoot, ['status', '--porcelain']),
      runGit(session.worktreeRoot, [
        'rev-list',
        '--count',
        `${session.baseCommit}..HEAD`,
      ]),
    ]);
    if (statusResult.code !== 0 || commitsResult.code !== 0) {
      return null;
    }

    return {
      changedFiles: statusResult.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0).length,
      commits: Number.parseInt(commitsResult.stdout.trim(), 10) || 0,
    };
  }
}

export const worktreeManager = new WorktreeManager();
