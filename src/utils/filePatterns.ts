import fg from 'fast-glob';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

function _parseGitignore(filePath: string): {
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

type Rule = { type: 'ignore' | 'negate'; pattern: string };
const RULES_CACHE = new Map<string, { rules: Rule[]; timestamp: number }>();

async function collectGitignoreRulesOrderedAsync(
  cwd: string,
  opts?: { scanIgnore?: string[]; cacheTTL?: number }
): Promise<Rule[]> {
  const scanIgnore = [
    ...DEFAULT_EXCLUDE_DIRS.map((d) => `${d}/**`),
    ...(opts?.scanIgnore ?? []),
  ];
  const cacheKey = `${cwd}|${scanIgnore.join(',')}`;
  const now = Date.now();
  const cached = RULES_CACHE.get(cacheKey);
  const ttl = opts?.cacheTTL ?? 30000;
  if (cached && now - cached.timestamp < ttl) {
    return cached.rules;
  }

  const files = await fg('**/.gitignore', {
    cwd,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: scanIgnore,
  });
  files.sort((a, b) => a.split('/').length - b.split('/').length);
  const rules: Rule[] = [];
  for (const rel of files) {
    const dirRaw = dirname(rel).replace(/\\/g, '/');
    const dir = dirRaw === '.' ? '' : dirRaw;
    const content = await readFile(join(cwd, rel), 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const isNegate = trimmed.startsWith('!');
      const bodyRaw = isNegate ? trimmed.slice(1) : trimmed;
      const s = bodyRaw.trim();
      if (!s) continue;
      let pattern = '';
      if (s.startsWith('/')) {
        const body = s.slice(1).replace(/\\/g, '/');
        pattern = (dir ? dir + '/' : '') + body;
        rules.push({ type: isNegate ? 'negate' : 'ignore', pattern });
        if (s.endsWith('/')) {
          const withGlob = pattern + '**';
          rules.push({ type: isNegate ? 'negate' : 'ignore', pattern: withGlob });
          const trimmedDir = pattern.replace(/\/$/, '');
          if (trimmedDir !== pattern) {
            rules.push({ type: isNegate ? 'negate' : 'ignore', pattern: trimmedDir });
          }
        }
      } else {
        const sp = s.replace(/\\/g, '/');
        if (sp.includes('/')) {
          pattern = (dir ? dir + '/' : '') + sp;
          rules.push({ type: isNegate ? 'negate' : 'ignore', pattern });
          if (sp.endsWith('/')) {
            const withGlob = pattern + '**';
            rules.push({ type: isNegate ? 'negate' : 'ignore', pattern: withGlob });
            const trimmedDir = pattern.replace(/\/$/, '');
            if (trimmedDir !== pattern) {
              rules.push({ type: isNegate ? 'negate' : 'ignore', pattern: trimmedDir });
            }
          }
        } else {
          pattern = (dir ? dir + '/**/' : '**/') + sp;
          rules.push({ type: isNegate ? 'negate' : 'ignore', pattern });
        }
      }
    }
  }
  RULES_CACHE.set(cacheKey, { rules, timestamp: now });
  return rules;
}

export interface FileFilterOptions {
  cwd?: string;
  useGitignore?: boolean;
  useDefaults?: boolean;
  customPatterns?: string[];
  gitignoreScanMode?: 'root' | 'recursive';
  customScanIgnore?: string[];
  cacheTTL?: number;
}

export class FileFilter {
  private orderedRules: Array<{
    type: 'ignore' | 'negate';
    matcher: (path: string) => boolean;
  }> = [];
  private ignorePatterns: string[] = []; // 保存原始 ignore 模式
  private negatePatterns: string[] = []; // 保存原始 negate 模式

  constructor(options: FileFilterOptions = {}) {
    this.initialize(options);
  }

  static async create(options: FileFilterOptions = {}): Promise<FileFilter> {
    const inst = new FileFilter({ ...options, useGitignore: false });
    const {
      cwd = process.cwd(),
      useGitignore = true,
      gitignoreScanMode = 'root',
      customScanIgnore = [],
      cacheTTL,
    } = options;
    if (useGitignore && gitignoreScanMode === 'recursive') {
      const ordered = await collectGitignoreRulesOrderedAsync(cwd, {
        scanIgnore: customScanIgnore,
        cacheTTL,
      });
      for (const r of ordered) {
        inst.orderedRules.push({
          type: r.type,
          matcher: picomatch(r.pattern, { dot: true }),
        });
        if (r.type === 'ignore') inst.ignorePatterns.push(r.pattern);
        else inst.negatePatterns.push(r.pattern);
      }
    }
    return inst;
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
      const defaults = [
        ...DEFAULT_EXCLUDE_DIRS.map((dir) => `${dir}/**`),
        ...DEFAULT_EXCLUDE_DIRS,
        ...DEFAULT_EXCLUDE_FILE_PATTERNS,
      ];
      allPatterns.push(...defaults);
      for (const p of defaults) {
        this.orderedRules.push({
          type: 'ignore',
          matcher: picomatch(p, { dot: true }),
        });
      }
    }

    if (useGitignore) {
      const rootGitignore = join(cwd, '.gitignore');
      const { patterns, negatePatterns } = _parseGitignore(rootGitignore);
      for (const p of patterns) {
        this.orderedRules.push({
          type: 'ignore',
          matcher: picomatch(p, { dot: true }),
        });
        allPatterns.push(p);
      }
      for (const n of negatePatterns) {
        this.orderedRules.push({
          type: 'negate',
          matcher: picomatch(n, { dot: true }),
        });
        allNegatePatterns.push(n);
      }
    }

    allPatterns.push(...customPatterns);

    // 将自定义忽略模式也加入有序规则，保持顺序与“最后匹配 wins”
    for (const p of customPatterns) {
      this.orderedRules.push({ type: 'ignore', matcher: picomatch(p, { dot: true }) });
    }

    // 保存原始模式，供 fast-glob 使用
    this.ignorePatterns = allPatterns;
    this.negatePatterns = allNegatePatterns;

    // orderedRules 保留插入顺序，实现 "last match wins"
  }

  shouldIgnore(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    let matched: boolean | undefined = undefined;
    for (const rule of this.orderedRules) {
      if (rule.matcher(normalized)) {
        matched = rule.type === 'ignore';
      }
    }
    return matched === true;
  }

  shouldIgnoreDirectory(dirName: string): boolean {
    const p = dirName.replace(/\\/g, '/');
    return this.shouldIgnore(p) || this.shouldIgnore(`${p}/`);
  }

  filter(paths: string[]): string[] {
    return paths.filter((path) => !this.shouldIgnore(path));
  }

  /**
   * 获取 ignore 模式，供 fast-glob 使用
   * @returns ignore 模式数组（不包含 negation 模式）
   */
  getIgnorePatterns(): string[] {
    return this.ignorePatterns;
  }

  /**
   * 获取 negation 模式，供调试或参考使用
   * @returns negation 模式数组
   */
  getNegatePatterns(): string[] {
    return this.negatePatterns;
  }
}

export function getExcludePatterns(customPatterns: string[] = []): string[] {
  return [...DEFAULT_EXCLUDE_DIRS, ...DEFAULT_EXCLUDE_FILE_PATTERNS, ...customPatterns];
}
