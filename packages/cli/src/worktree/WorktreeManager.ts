import { type ExecFileException, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { basename, isAbsolute, join, relative, resolve } from 'pathe';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import type { SessionTaskDiffStat, SessionTaskWorktree } from '../context/types.js';

const MAX_WORKTREE_NAME_LENGTH = 64;
const VALID_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const EPHEMERAL_MANAGED_WORKTREE = /^(?:agent|task)\+[a-zA-Z0-9_-]{1,40}$/;
const DEFAULT_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DIFF_FILES = 100;
const MAX_DIFF_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_TOTAL_BYTES = 2 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeSession extends SessionTaskWorktree {}

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

export interface WorktreeChangeSummary extends SessionTaskDiffStat {}

export interface WorktreeDiffFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
}

export interface WorktreeDiffArtifact {
  baseCommit: string;
  files: WorktreeDiffFile[];
  truncated: boolean;
}

export interface WorktreeCleanupOptions {
  workspaceRoot: string;
  maxAgeMs?: number;
  now?: number;
}

export interface WorktreeCleanupResult {
  scanned: number;
  removed: number;
  preserved: number;
  skipped: number;
  errors: string[];
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

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || isAbsolute(filePath) || filePath.includes('\0')) return false;
  return !filePath.split('/').some((segment) => segment === '..');
}

function patchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function truncatePatch(
  patch: string,
  maxBytes: number
): { patch: string; truncated: boolean } {
  const encoded = Buffer.from(patch);
  if (encoded.byteLength <= maxBytes) return { patch, truncated: false };
  const suffix = '\n[diff truncated]\n';
  if (maxBytes <= Buffer.byteLength(suffix)) {
    return { patch: '', truncated: true };
  }
  const bodyLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  return {
    patch: `${encoded.subarray(0, bodyLimit).toString('utf8')}${suffix}`,
    truncated: true,
  };
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

  async getDiffArtifact(
    sessionId: string
  ): Promise<WorktreeDiffArtifact | null | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return this.inspectDiffArtifact(session);
  }

  async cleanupStaleAgentWorktrees(
    input: WorktreeCleanupOptions
  ): Promise<WorktreeCleanupResult> {
    const result: WorktreeCleanupResult = {
      scanned: 0,
      removed: 0,
      preserved: 0,
      skipped: 0,
      errors: [],
    };
    const maxAgeMs = input.maxAgeMs ?? DEFAULT_STALE_AGE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error('maxAgeMs must be a finite non-negative number');
    }

    const rootResult = await runGit(resolve(input.workspaceRoot), [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (rootResult.code !== 0) {
      const detail = rootResult.stderr.trim() || rootResult.stdout.trim();
      if (!/not a git repository|not a git work tree/i.test(detail)) {
        result.errors.push(`Resolve cleanup repository failed: ${detail}`);
      }
      return result;
    }

    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(rootResult.stdout.trim());
    } catch (error) {
      result.errors.push(
        `Resolve cleanup repository path failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return result;
    }

    const managedRoot = this.getManagedRoot(repositoryRoot);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(managedRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.errors.push(
          `Read managed worktrees failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return result;
    }

    const activeRoots = new Set(
      [...this.sessions.values()].map((session) => resolve(session.worktreeRoot))
    );
    const cutoff = (input.now ?? Date.now()) - maxAgeMs;

    for (const entry of entries) {
      if (!entry.isDirectory() || !EPHEMERAL_MANAGED_WORKTREE.test(entry.name)) {
        result.skipped++;
        continue;
      }

      const worktreeRoot = join(managedRoot, entry.name);
      result.scanned++;
      if (activeRoots.has(resolve(worktreeRoot))) {
        result.skipped++;
        continue;
      }

      let modifiedAt: number;
      try {
        modifiedAt = (await stat(worktreeRoot)).mtimeMs;
      } catch (error) {
        result.errors.push(
          `Inspect stale worktree "${entry.name}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      if (modifiedAt >= cutoff) {
        result.skipped++;
        continue;
      }

      const [resolvedRootResult, branchResult, statusResult, unpushedResult] =
        await Promise.all([
          runGit(worktreeRoot, ['rev-parse', '--show-toplevel']),
          runGit(worktreeRoot, ['branch', '--show-current']),
          runGit(worktreeRoot, ['--no-optional-locks', 'status', '--porcelain']),
          runGit(worktreeRoot, [
            'rev-list',
            '--max-count=1',
            'HEAD',
            '--not',
            '--remotes',
          ]),
        ]);
      if (
        resolvedRootResult.code !== 0 ||
        branchResult.code !== 0 ||
        statusResult.code !== 0 ||
        unpushedResult.code !== 0
      ) {
        result.errors.push(`Git inspection failed for stale worktree "${entry.name}"`);
        continue;
      }

      const branch = branchResult.stdout.trim();
      let canonicalWorktreeRoot: string;
      let canonicalResolvedRoot: string;
      try {
        [canonicalWorktreeRoot, canonicalResolvedRoot] = await Promise.all([
          realpath(worktreeRoot),
          realpath(resolvedRootResult.stdout.trim()),
        ]);
      } catch (error) {
        result.errors.push(
          `Canonical path inspection failed for "${entry.name}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      if (
        canonicalWorktreeRoot !== canonicalResolvedRoot ||
        !/^blade-worktree-(?:agent|task)\+/.test(branch)
      ) {
        result.errors.push(`Managed worktree identity mismatch for "${entry.name}"`);
        continue;
      }

      if (
        statusResult.stdout.trim().length > 0 ||
        unpushedResult.stdout.trim().length > 0
      ) {
        result.preserved++;
        continue;
      }

      const removeResult = await runGit(repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        worktreeRoot,
      ]);
      if (removeResult.code !== 0) {
        result.errors.push(
          `Remove stale worktree "${entry.name}" failed: ${
            removeResult.stderr.trim() || removeResult.stdout.trim()
          }`
        );
        continue;
      }

      result.removed++;
      const branchDeleteResult = await runGit(repositoryRoot, ['branch', '-D', branch]);
      if (branchDeleteResult.code !== 0) {
        result.errors.push(
          `Delete stale branch "${branch}" failed: ${
            branchDeleteResult.stderr.trim() || branchDeleteResult.stdout.trim()
          }`
        );
      }
    }

    if (result.removed > 0) {
      const pruneResult = await runGit(repositoryRoot, ['worktree', 'prune']);
      if (pruneResult.code !== 0) {
        result.errors.push(
          `Prune stale worktree registrations failed: ${
            pruneResult.stderr.trim() || pruneResult.stdout.trim()
          }`
        );
      }
    }

    return result;
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

  private async inspectDiffArtifact(
    session: WorktreeSession
  ): Promise<WorktreeDiffArtifact | null> {
    const [trackedResult, untrackedResult] = await Promise.all([
      runGit(session.worktreeRoot, [
        'diff',
        '--name-only',
        '-z',
        session.baseCommit,
        '--',
      ]),
      runGit(session.worktreeRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
    ]);
    if (trackedResult.code !== 0 || untrackedResult.code !== 0) return null;

    const trackedPaths = new Set(
      trackedResult.stdout.split('\0').filter(isSafeRelativePath)
    );
    const untrackedPaths = new Set(
      untrackedResult.stdout.split('\0').filter(isSafeRelativePath)
    );
    const allPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
    const selectedPaths = allPaths.slice(0, MAX_DIFF_FILES);
    const generated = await Promise.all(
      selectedPaths.map(async (filePath): Promise<WorktreeDiffFile> => {
        const isUntracked = !trackedPaths.has(filePath) && untrackedPaths.has(filePath);
        try {
          const fileStat = await lstat(join(session.worktreeRoot, filePath));
          if (fileStat.size > MAX_DIFF_FILE_BYTES) {
            return {
              path: filePath,
              patch: '',
              additions: 0,
              deletions: 0,
              binary: false,
              truncated: true,
            };
          }
          if (isUntracked && !fileStat.isFile()) {
            return {
              path: filePath,
              patch: '',
              additions: 0,
              deletions: 0,
              binary: true,
              truncated: false,
            };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const diffResult = isUntracked
          ? await runGit(session.worktreeRoot, [
              'diff',
              '--no-index',
              '--no-ext-diff',
              '--no-color',
              '--unified=3',
              '--',
              '/dev/null',
              filePath,
            ])
          : await runGit(session.worktreeRoot, [
              'diff',
              '--no-ext-diff',
              '--no-color',
              '--unified=3',
              session.baseCommit,
              '--',
              filePath,
            ]);
        if (
          (!isUntracked && diffResult.code !== 0) ||
          (isUntracked && ![0, 1].includes(diffResult.code))
        ) {
          throw new Error(`Generate task diff failed for ${filePath}`);
        }

        const rawPatch =
          isUntracked && diffResult.stdout.length === 0
            ? [
                `diff --git a/${filePath} b/${filePath}`,
                'new file mode 100644',
                '--- /dev/null',
                `+++ b/${filePath}`,
                '',
              ].join('\n')
            : diffResult.stdout;
        const binary =
          /^Binary files .+ differ$/m.test(rawPatch) ||
          rawPatch.includes('GIT binary patch');
        const stats = binary ? { additions: 0, deletions: 0 } : patchStats(rawPatch);
        const limited = truncatePatch(rawPatch, MAX_DIFF_FILE_BYTES);
        return {
          path: filePath,
          patch: limited.patch,
          ...stats,
          binary,
          truncated: limited.truncated,
        };
      })
    );

    let remainingBytes = MAX_DIFF_TOTAL_BYTES;
    let truncated = allPaths.length > selectedPaths.length;
    const files = generated.map((file) => {
      const limited = truncatePatch(file.patch, remainingBytes);
      remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(limited.patch));
      truncated ||= limited.truncated;
      return limited.truncated
        ? { ...file, patch: limited.patch, truncated: true }
        : file;
    });

    return {
      baseCommit: session.baseCommit,
      files,
      truncated,
    };
  }

  private async inspectChanges(
    session: WorktreeSession
  ): Promise<WorktreeChangeSummary | null> {
    const [statusResult, commitsResult, diffResult, untrackedResult] =
      await Promise.all([
        runGit(session.worktreeRoot, ['status', '--porcelain']),
        runGit(session.worktreeRoot, [
          'rev-list',
          '--count',
          `${session.baseCommit}..HEAD`,
        ]),
        runGit(session.worktreeRoot, ['diff', '--numstat', session.baseCommit, '--']),
        runGit(session.worktreeRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
        ]),
      ]);
    if (
      statusResult.code !== 0 ||
      commitsResult.code !== 0 ||
      diffResult.code !== 0 ||
      untrackedResult.code !== 0
    ) {
      return null;
    }

    let additions = 0;
    let deletions = 0;
    for (const line of diffResult.stdout.split('\n')) {
      const [added, deleted] = line.split('\t');
      if (/^\d+$/.test(added ?? '')) additions += Number(added);
      if (/^\d+$/.test(deleted ?? '')) deletions += Number(deleted);
    }
    for (const file of untrackedResult.stdout.split('\0').filter(Boolean)) {
      try {
        const filePath = join(session.worktreeRoot, file);
        const fileStat = await lstat(filePath);
        if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) continue;
        const content = await readFile(filePath);
        if (content.includes(0)) continue;
        const text = content.toString('utf8');
        if (text.length > 0) {
          additions += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        }
      } catch {
        // Git may report a path that changes before inspection completes.
      }
    }

    return {
      changedFiles: statusResult.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0).length,
      additions,
      deletions,
      commits: Number.parseInt(commitsResult.stdout.trim(), 10) || 0,
    };
  }
}

export const worktreeManager = new WorktreeManager();
