import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';

export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  '.idea',
  '.vscode',
  '.vs',
  'bower_components',
  'jspm_packages',
] as const;

export const DEFAULT_EXCLUDE_FILE_PATTERNS = [
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'pnpm-debug.log*',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.bak',
  '*~',
  '.DS_Store',
  'Thumbs.db',
  '*.pid',
  '*.seed',
] as const;

function parseGitignore(filePath: string): {
  patterns: string[];
  negatePatterns: string[];
} {
  if (!existsSync(filePath)) {
    return { patterns: [], negatePatterns: [] };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const patterns: string[] = [];
    const negatePatterns: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('!')) {
        negatePatterns.push(trimmed.slice(1));
      } else {
        patterns.push(trimmed);
      }
    }

    return { patterns, negatePatterns };
  } catch (error) {
    console.warn(`Failed to read .gitignore: ${error}`);
    return { patterns: [], negatePatterns: [] };
  }
}

export interface FileFilterOptions {
  cwd?: string;
  useGitignore?: boolean;
  useDefaults?: boolean;
  customPatterns?: string[];
}

export class FileFilter {
  private ignoreMatchers: Array<(path: string) => boolean> = [];
  private negateMatchers: Array<(path: string) => boolean> = [];

  constructor(options: FileFilterOptions = {}) {
    this.initialize(options);
  }

  private initialize(options: FileFilterOptions): void {
    const {
      cwd = process.cwd(),
      useGitignore = true,
      useDefaults = true,
      customPatterns = [],
    } = options;

    const allPatterns: string[] = [];
    const allNegatePatterns: string[] = [];

    if (useDefaults) {
      allPatterns.push(
        ...DEFAULT_EXCLUDE_DIRS.map((dir) => `${dir}/**`),
        ...DEFAULT_EXCLUDE_DIRS,
        ...DEFAULT_EXCLUDE_FILE_PATTERNS
      );
    }

    if (useGitignore) {
      const gitignorePath = join(cwd, '.gitignore');
      const { patterns, negatePatterns } = parseGitignore(gitignorePath);
      allPatterns.push(...patterns);
      allNegatePatterns.push(...negatePatterns);
    }

    allPatterns.push(...customPatterns);

    if (allPatterns.length > 0) {
      this.ignoreMatchers = allPatterns.map((pattern) =>
        picomatch(pattern, { dot: true })
      );
    }

    if (allNegatePatterns.length > 0) {
      this.negateMatchers = allNegatePatterns.map((pattern) =>
        picomatch(pattern, { dot: true })
      );
    }
  }

  shouldIgnore(path: string): boolean {
    const isNegated = this.negateMatchers.some((matcher) => matcher(path));
    if (isNegated) return false;

    return this.ignoreMatchers.some((matcher) => matcher(path));
  }

  shouldIgnoreDirectory(dirName: string): boolean {
    return this.shouldIgnore(dirName) || this.shouldIgnore(`${dirName}/`);
  }

  filter(paths: string[]): string[] {
    return paths.filter((path) => !this.shouldIgnore(path));
  }
}


export function getExcludePatterns(customPatterns: string[] = []): string[] {
  return [
    ...DEFAULT_EXCLUDE_DIRS,
    ...DEFAULT_EXCLUDE_FILE_PATTERNS,
    ...customPatterns,
  ];
}
