import path from 'node:path';
import fg from 'fast-glob';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { LRUCache } from 'lru-cache';
import { DEFAULT_EXCLUDE_DIRS, FileFilter } from '../utils/filePatterns.js';

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_WORKSPACES = 32;

export interface FileNameMatch {
  path: string;
  score: number;
  isDirectory: boolean;
}

export interface FileNameSearchOptions {
  cwd: string;
  limit?: number;
  includeDirectories?: boolean;
  ignorePatterns?: readonly string[];
  fuzzy?: boolean;
  signal?: AbortSignal;
}

interface FileNameIndexEntry {
  path: string;
  isDirectory: boolean;
}

interface FileNameIndexSnapshot {
  entries: FileNameIndexEntry[];
  files: FileNameIndexEntry[];
  allIndex: Fuse<FileNameIndexEntry>;
  fileIndex: Fuse<FileNameIndexEntry>;
}

export class FileNameIndex {
  private readonly snapshots: LRUCache<string, Promise<FileNameIndexSnapshot>>;

  constructor(options?: { cacheTtlMs?: number; maxWorkspaces?: number }) {
    this.snapshots = new LRUCache({
      max: options?.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES,
      ttl: options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    });
  }

  async search(
    query: string,
    options: FileNameSearchOptions
  ): Promise<FileNameMatch[]> {
    options.signal?.throwIfAborted();
    const snapshot = await this.getSnapshot(options);
    options.signal?.throwIfAborted();

    const limit = Math.max(1, Math.floor(options.limit ?? 20));
    const entries = options.includeDirectories ? snapshot.entries : snapshot.files;
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      return entries.slice(0, limit).map((entry) => ({
        ...entry,
        score: 0,
      }));
    }

    if (options.fuzzy === false) {
      const lowerQuery = normalizedQuery.toLowerCase();
      return entries
        .filter((entry) => entry.path.toLowerCase().includes(lowerQuery))
        .slice(0, limit)
        .map((entry) => ({ ...entry, score: 0 }));
    }

    const index = options.includeDirectories ? snapshot.allIndex : snapshot.fileIndex;
    return index.search(normalizedQuery, { limit }).map((result) => ({
      ...result.item,
      score: result.score ?? 1,
    }));
  }

  invalidate(cwd?: string): void {
    if (!cwd) {
      this.snapshots.clear();
      return;
    }

    const prefix = `${path.resolve(cwd)}\0`;
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(prefix)) this.snapshots.delete(key);
    }
  }

  private async getSnapshot(
    options: FileNameSearchOptions
  ): Promise<FileNameIndexSnapshot> {
    const cwd = path.resolve(options.cwd);
    const ignorePatterns = options.ignorePatterns
      ? [...options.ignorePatterns]
      : undefined;
    const cacheKey = `${cwd}\0${JSON.stringify(ignorePatterns ?? null)}`;
    const cached = this.snapshots.get(cacheKey);
    if (cached) return await cached;

    const pending = this.buildSnapshot(cwd, ignorePatterns);
    this.snapshots.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      this.snapshots.delete(cacheKey);
      throw error;
    }
  }

  private async buildSnapshot(
    cwd: string,
    ignorePatterns: string[] | undefined
  ): Promise<FileNameIndexSnapshot> {
    const fileFilter = await FileFilter.create({
      cwd,
      useGitignore: true,
      useDefaults: ignorePatterns === undefined,
      customPatterns: ignorePatterns ?? [],
      gitignoreScanMode: 'recursive',
      customScanIgnore: DEFAULT_EXCLUDE_DIRS.map((directory) => `${directory}/**`),
      cacheTTL: DEFAULT_CACHE_TTL_MS,
    });

    const found = await fg('**/*', {
      cwd,
      dot: false,
      followSymbolicLinks: false,
      onlyFiles: false,
      markDirectories: true,
      unique: true,
      ignore: fileFilter.getIgnorePatterns(),
    });

    const entries = found
      .map((candidate) => candidate.replaceAll('\\', '/'))
      .filter((candidate) => !fileFilter.shouldIgnore(candidate))
      .map((candidate) => ({
        path: candidate,
        isDirectory: candidate.endsWith('/'),
      }));
    const files = entries.filter((entry) => !entry.isDirectory);
    const fuseOptions: IFuseOptions<FileNameIndexEntry> = {
      keys: ['path'],
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 1,
    };

    return {
      entries,
      files,
      allIndex: new Fuse(entries, fuseOptions),
      fileIndex: new Fuse(files, fuseOptions),
    };
  }
}

export const fileNameIndex = new FileNameIndex();
