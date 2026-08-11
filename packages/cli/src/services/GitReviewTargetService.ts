import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  SessionReviewTargetInfo,
  SessionReviewTargetKind,
} from '../context/types.js';

const execFileAsync = promisify(execFile);
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_FILES = 500;
const MAX_REVIEW_REF_LENGTH = 200;

export interface CodeReviewTargetRequest {
  kind: SessionReviewTargetKind;
  ref?: string;
}

export interface ResolvedCodeReviewTarget {
  info: SessionReviewTargetInfo;
  instruction: string;
  changedLines: ReadonlyMap<string, readonly ReviewLineRange[]>;
}

export interface ReviewLineRange {
  start: number;
  end: number;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-c', 'core.pager=cat', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: MAX_REVIEW_BYTES + 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return result.stdout;
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes('maxBuffer')
        ? `Review target exceeds the ${MAX_REVIEW_BYTES} byte limit`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Git review target failed: ${message}`);
  }
}

function validateRef(value: string | undefined, label: string): string {
  const ref = value?.trim();
  if (
    !ref ||
    ref.length > MAX_REVIEW_REF_LENGTH ||
    ref.includes('\0') ||
    ref.includes('\n') ||
    ref.includes('\r')
  ) {
    throw new Error(`${label} must contain 1-${MAX_REVIEW_REF_LENGTH} characters`);
  }
  return ref;
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

async function hashUntrackedFiles(
  workspaceRoot: string,
  files: readonly string[],
  hash: ReturnType<typeof createHash>,
  changedLines: Map<string, ReviewLineRange[]>,
  initialBytes: number
): Promise<void> {
  let totalBytes = initialBytes;
  const canonicalRoot = await realpath(workspaceRoot);
  for (const file of files) {
    const resolved = path.resolve(canonicalRoot, file);
    const relative = path.relative(canonicalRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Untracked review path escapes the workspace: ${file}`);
    }
    const stats = await lstat(resolved);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Untracked review target must be a regular file: ${file}`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_REVIEW_BYTES) {
      throw new Error(`Review target exceeds ${MAX_REVIEW_BYTES} bytes`);
    }
    hash.update('\0untracked\0');
    hash.update(relative.replaceAll(path.sep, '/'));
    hash.update('\0');
    const content = await readFile(resolved);
    hash.update(content);
    const lineCount = Math.max(1, content.toString('utf8').split('\n').length);
    changedLines.set(relative.replaceAll(path.sep, '/'), [
      { start: 1, end: lineCount },
    ]);
  }
}

function changedLinesFromDiff(
  diff: string,
  files: readonly string[]
): Map<string, ReviewLineRange[]> {
  const changedLines = new Map<string, ReviewLineRange[]>();
  let oldPath: string | undefined;
  let currentPath: string | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let deletedFile = false;
  const recordLine = (file: string, line: number) => {
    const ranges = changedLines.get(file) ?? [];
    const previous = ranges.at(-1);
    if (previous && line <= previous.end + 1)
      previous.end = Math.max(previous.end, line);
    else ranges.push({ start: line, end: line });
    changedLines.set(file, ranges);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const raw = line.slice(4).split('\t')[0]?.trim();
      oldPath =
        raw && raw !== '/dev/null'
          ? raw.replace(/^a\//, '').replaceAll('\\', '/')
          : undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).split('\t')[0]?.trim();
      deletedFile = raw === '/dev/null';
      currentPath = deletedFile
        ? oldPath
        : raw
          ? raw.replace(/^b\//, '').replaceAll('\\', '/')
          : undefined;
      oldLine = undefined;
      newLine = undefined;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/.exec(line);
      oldLine = match ? Math.max(1, Number(match[1])) : undefined;
      newLine = match ? Math.max(1, Number(match[2])) : undefined;
      continue;
    }
    if (!currentPath || oldLine === undefined || newLine === undefined) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      recordLine(currentPath, newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      recordLine(currentPath, deletedFile ? oldLine : newLine);
      oldLine++;
    } else if (!line.startsWith('\\')) {
      oldLine++;
      newLine++;
    }
  }
  for (const file of files) {
    if (!changedLines.has(file)) {
      changedLines.set(file, [{ start: 1, end: 1 }]);
    }
  }
  return changedLines;
}

function assertFileBudget(files: readonly string[]): void {
  if (files.length > MAX_REVIEW_FILES) {
    throw new Error(`Review target exceeds the ${MAX_REVIEW_FILES} file limit`);
  }
}

export class GitReviewTargetService {
  static async resolve(
    workspaceRoot: string,
    request: CodeReviewTargetRequest
  ): Promise<ResolvedCodeReviewTarget> {
    const root = await realpath(workspaceRoot);
    await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    const headSha = await resolveCommit(root, 'HEAD');
    const hash = createHash('sha256');
    hash.update(`kind\0${request.kind}\0head\0${headSha}\0`);
    let diff = '';
    let files: string[] = [];
    let baseSha: string | undefined;
    let commitSha: string | undefined;
    let label: string;
    let instruction: string;
    let changedLines = new Map<string, ReviewLineRange[]>();

    switch (request.kind) {
      case 'uncommitted': {
        diff = await runGit(root, [
          'diff',
          '--binary',
          '--no-ext-diff',
          '--relative',
          'HEAD',
          '--',
          '.',
        ]);
        const trackedFiles = splitNull(
          await runGit(root, [
            'diff',
            '--name-only',
            '-z',
            '--relative',
            'HEAD',
            '--',
            '.',
          ])
        );
        const untrackedFiles = splitNull(
          await runGit(root, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            '.',
          ])
        );
        files = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
        assertFileBudget(files);
        if (files.length === 0) {
          throw new Error('No uncommitted changes to review');
        }
        hash.update(diff);
        changedLines = changedLinesFromDiff(diff, trackedFiles);
        await hashUntrackedFiles(
          root,
          untrackedFiles,
          hash,
          changedLines,
          Buffer.byteLength(diff)
        );
        label = 'uncommitted changes';
        instruction = [
          'Review the uncommitted working tree against HEAD.',
          'Use git status --short, git diff --cached, and git diff, then inspect',
          'every relevant untracked file listed by git status.',
        ].join(' ');
        break;
      }
      case 'base': {
        const ref = validateRef(request.ref, 'Base ref');
        baseSha = await resolveCommit(root, ref);
        const mergeBase = (await runGit(root, ['merge-base', baseSha, headSha])).trim();
        diff = await runGit(root, [
          'diff',
          '--binary',
          '--no-ext-diff',
          '--relative',
          `${mergeBase}..${headSha}`,
          '--',
          '.',
        ]);
        files = splitNull(
          await runGit(root, [
            'diff',
            '--name-only',
            '-z',
            '--relative',
            `${mergeBase}..${headSha}`,
            '--',
            '.',
          ])
        );
        assertFileBudget(files);
        if (files.length === 0) {
          throw new Error(`No changes between ${ref} and HEAD`);
        }
        hash.update(diff);
        hash.update(`\0merge-base\0${mergeBase}`);
        changedLines = changedLinesFromDiff(diff, files);
        label = `changes against ${ref}`;
        instruction = `Review changes introduced by ${mergeBase}..${headSha}.`;
        break;
      }
      case 'commit': {
        const ref = validateRef(request.ref, 'Commit ref');
        commitSha = await resolveCommit(root, ref);
        diff = await runGit(root, [
          'show',
          '--format=',
          '--binary',
          '--no-ext-diff',
          '--relative',
          commitSha,
          '--',
          '.',
        ]);
        files = splitNull(
          await runGit(root, [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-only',
            '-r',
            '-z',
            commitSha,
            '--',
            '.',
          ])
        );
        assertFileBudget(files);
        if (files.length === 0) {
          throw new Error(`Commit has no changes in this workspace: ${ref}`);
        }
        hash.update(diff);
        hash.update(`\0commit\0${commitSha}`);
        changedLines = changedLinesFromDiff(diff, files);
        label = `commit ${ref}`;
        instruction = `Review only the changes introduced by commit ${commitSha}.`;
        break;
      }
    }

    if (Buffer.byteLength(diff) > MAX_REVIEW_BYTES) {
      throw new Error(`Review diff exceeds ${MAX_REVIEW_BYTES} bytes`);
    }

    return {
      info: {
        kind: request.kind,
        label,
        headSha,
        ...(baseSha ? { baseSha } : {}),
        ...(commitSha ? { commitSha } : {}),
        digest: hash.digest('hex'),
        fileCount: files.length,
      },
      instruction,
      changedLines,
    };
  }
}
