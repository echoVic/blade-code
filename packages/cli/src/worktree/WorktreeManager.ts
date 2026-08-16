import { type ExecFileException, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'pathe';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import type { SessionTaskDiffStat, SessionTaskWorktree } from '../context/types.js';
import { KeyedMutexRegistry } from '../utils/KeyedMutexRegistry.js';

const MAX_WORKTREE_NAME_LENGTH = 64;
const VALID_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const EPHEMERAL_MANAGED_WORKTREE = /^(?:agent|task)\+[a-zA-Z0-9_-]{1,40}$/;
const DEFAULT_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DIFF_FILES = 100;
const MAX_DIFF_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERY_PATCH_BYTES = 50 * 1024 * 1024;
const EMPTY_STATE_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunGitOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
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

export type WorktreeDeliveryConflictReason =
  | 'source_unavailable'
  | 'source_head_changed'
  | 'source_state_changed'
  | 'legacy_dirty_source'
  | 'artifact_unavailable'
  | 'no_changes'
  | 'patch_conflict';

export class WorktreeDeliveryConflict extends Error {
  constructor(
    public readonly reason: WorktreeDeliveryConflictReason,
    message: string
  ) {
    super(message);
    this.name = 'WorktreeDeliveryConflict';
  }
}

export interface WorktreeApplyResult {
  action: 'apply';
  workspaceRoot: string;
  worktreeRoot: string;
  branch: string;
  sourceCommit: string;
  changedFiles: number;
  additions: number;
  deletions: number;
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

async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {}
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        env: {
          ...process.env,
          ...options.env,
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

function updateHashFromFile(hash: ReturnType<typeof createHash>, filePath: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
}

async function fingerprintWorkingState(repositoryRoot: string): Promise<string> {
  const status = await runGit(repositoryRoot, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  requireGitSuccess(status, 'Inspect source worktree');

  const hash = createHash('sha256');
  hash.update(status.stdout);
  const tokens = status.stdout.split('\0').filter(Boolean);
  const paths = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const state = token.slice(0, 2);
    const filePath = token.slice(3);
    if (isSafeRelativePath(filePath)) paths.add(filePath);
    if (/[RC]/.test(state)) {
      const originalPath = tokens[++index];
      if (originalPath && isSafeRelativePath(originalPath)) {
        paths.add(originalPath);
      }
    }
  }

  for (const filePath of [...paths].sort()) {
    hash.update(`\0${filePath}\0`);
    const absolutePath = join(repositoryRoot, filePath);
    try {
      const fileStat = await lstat(absolutePath);
      hash.update(`${fileStat.mode}:${fileStat.size}:`);
      if (fileStat.isSymbolicLink()) {
        hash.update(await readlink(absolutePath));
      } else if (fileStat.isFile()) {
        await updateHashFromFile(hash, absolutePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('missing');
    }
  }
  return hash.digest('hex');
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
  private readonly sessionLocks = new KeyedMutexRegistry<string>();

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
    return this.sessionLocks.runExclusive(input.sessionId, async () => {
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

      const [baseCommitResult, branchResult, statusResult, sourceStateFingerprint] =
        await Promise.all([
          runGit(repositoryRoot, ['rev-parse', 'HEAD']),
          runGit(repositoryRoot, ['branch', '--show-current']),
          runGit(repositoryRoot, ['status', '--porcelain']),
          fingerprintWorkingState(repositoryRoot),
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
        sourceStateFingerprint,
      };
      this.sessions.set(input.sessionId, session);
      return session;
    });
  }

  async restoreSession(session: WorktreeSession): Promise<WorktreeSession> {
    return this.sessionLocks.runExclusive(session.sessionId, async () => {
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

  async apply(sessionId: string): Promise<WorktreeApplyResult> {
    return this.sessionLocks.runExclusive(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new WorktreeDeliveryConflict(
          'artifact_unavailable',
          'Task worktree is unavailable'
        );
      }

      let sourceRoot: string;
      try {
        sourceRoot = await realpath(session.repositoryRoot);
      } catch {
        throw new WorktreeDeliveryConflict(
          'source_unavailable',
          'Source workspace is unavailable'
        );
      }
      if (sourceRoot !== session.repositoryRoot) {
        throw new WorktreeDeliveryConflict(
          'source_unavailable',
          'Source workspace identity changed'
        );
      }

      const headResult = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
      const sourceCommit = requireGitSuccess(headResult, 'Resolve source HEAD');
      if (sourceCommit !== session.baseCommit) {
        throw new WorktreeDeliveryConflict(
          'source_head_changed',
          'Source branch advanced after this task started'
        );
      }

      if (!session.sourceStateFingerprint && session.sourceHadChanges) {
        throw new WorktreeDeliveryConflict(
          'legacy_dirty_source',
          'This older task started from a modified source workspace and cannot be applied automatically'
        );
      }
      const sourceStateFingerprint = await fingerprintWorkingState(sourceRoot);
      if (
        session.sourceStateFingerprint &&
        sourceStateFingerprint !== session.sourceStateFingerprint
      ) {
        throw new WorktreeDeliveryConflict(
          'source_state_changed',
          'Source workspace changed after this task started'
        );
      }
      if (
        !session.sourceStateFingerprint &&
        sourceStateFingerprint !== EMPTY_STATE_HASH
      ) {
        throw new WorktreeDeliveryConflict(
          'source_state_changed',
          'Source workspace has local changes'
        );
      }

      const changeSummary = await this.inspectChanges(session);
      if (!changeSummary) {
        throw new WorktreeDeliveryConflict(
          'artifact_unavailable',
          'Task changes could not be inspected'
        );
      }
      if (changeSummary.changedFiles === 0) {
        throw new WorktreeDeliveryConflict(
          'no_changes',
          'Task has no changes to apply'
        );
      }

      await mkdir(this.storageRoot, { recursive: true });
      const temporaryRoot = await mkdtemp(join(this.storageRoot, 'delivery-'));
      const indexPath = join(temporaryRoot, 'index');
      const patchPath = join(temporaryRoot, 'changes.patch');
      const gitOptions = { env: { GIT_INDEX_FILE: indexPath } };
      try {
        requireGitSuccess(
          await runGit(session.worktreeRoot, ['read-tree', 'HEAD'], gitOptions),
          'Prepare task delivery index'
        );
        requireGitSuccess(
          await runGit(session.worktreeRoot, ['add', '-A', '--'], gitOptions),
          'Collect task changes'
        );
        const tree = requireGitSuccess(
          await runGit(session.worktreeRoot, ['write-tree'], gitOptions),
          'Create task delivery tree'
        );
        const patchResult = await runGit(
          session.worktreeRoot,
          [
            'diff',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            session.baseCommit,
            tree,
            '--',
          ],
          { maxBuffer: MAX_DELIVERY_PATCH_BYTES + 1024 }
        );
        requireGitSuccess(patchResult, 'Generate task delivery patch');
        const patch = patchResult.stdout;
        if (!patch) {
          throw new WorktreeDeliveryConflict(
            'no_changes',
            'Task has no changes to apply'
          );
        }
        if (Buffer.byteLength(patch) > MAX_DELIVERY_PATCH_BYTES) {
          throw new WorktreeDeliveryConflict(
            'artifact_unavailable',
            'Task changes exceed the 50 MiB delivery limit'
          );
        }
        await writeFile(patchPath, patch, { mode: 0o600 });

        const check = await runGit(sourceRoot, [
          'apply',
          '--check',
          '--binary',
          '--whitespace=nowarn',
          patchPath,
        ]);
        if (check.code !== 0) {
          throw new WorktreeDeliveryConflict(
            'patch_conflict',
            'Task changes conflict with the source workspace'
          );
        }
        const applied = await runGit(sourceRoot, [
          'apply',
          '--binary',
          '--whitespace=nowarn',
          patchPath,
        ]);
        if (applied.code !== 0) {
          throw new WorktreeDeliveryConflict(
            'patch_conflict',
            'Task changes could not be applied'
          );
        }
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }

      return {
        action: 'apply',
        workspaceRoot: session.originalWorkspaceRoot,
        worktreeRoot: session.worktreeRoot,
        branch: session.branch,
        sourceCommit,
        ...changeSummary,
      };
    });
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
    return this.sessionLocks.runExclusive(input.sessionId, async () => {
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

  coordinationStatsForTests() {
    return this.sessionLocks.getStats();
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
    const [changedResult, commitsResult, diffResult, untrackedResult] =
      await Promise.all([
        runGit(session.worktreeRoot, [
          'diff',
          '--name-only',
          '-z',
          session.baseCommit,
          '--',
        ]),
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
      changedResult.code !== 0 ||
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
      changedFiles: new Set([
        ...changedResult.stdout.split('\0').filter(Boolean),
        ...untrackedResult.stdout.split('\0').filter(Boolean),
      ]).size,
      additions,
      deletions,
      commits: Number.parseInt(commitsResult.stdout.trim(), 10) || 0,
    };
  }
}

export const worktreeManager = new WorktreeManager();
