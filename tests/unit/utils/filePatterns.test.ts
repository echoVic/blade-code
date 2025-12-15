import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
  FileFilter,
  getExcludePatterns,
} from '../../../src/utils/filePatterns.js';

describe('utils/filePatterns', () => {
  it('默认规则应忽略 node_modules 和常见输出目录', () => {
    const filter = new FileFilter({ useGitignore: false });

    expect(filter.shouldIgnore('node_modules/foo.js')).toBe(true);
    expect(filter.shouldIgnore('dist/main.js')).toBe(true);
    expect(filter.shouldIgnore('src/index.ts')).toBe(false);

    const files = [
      'src/index.ts',
      'node_modules/lib.js',
      'dist/bundle.js',
      'README.md',
    ];
    expect(filter.filter(files)).toEqual(['src/index.ts', 'README.md']);
  });

  it('应解析 .gitignore 并处理否定模式', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'file-filter-'));
    writeFileSync(
      path.join(tempDir, '.gitignore'),
      `build/\nlogs/*.log\n!build/keep.js\n`,
      'utf-8'
    );

    const filter = new FileFilter({ cwd: tempDir, useDefaults: false });

    expect(filter.shouldIgnoreDirectory('build')).toBe(true);
    expect(filter.shouldIgnore('build/keep.js')).toBe(false);
    expect(filter.shouldIgnore('logs/error.log')).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('自定义模式且禁用默认/ gitignore 时应仅使用自定义规则', () => {
    const filter = new FileFilter({
      useDefaults: false,
      useGitignore: false,
      customPatterns: ['*.log'],
    });

    expect(filter.shouldIgnore('error.log')).toBe(true);
    expect(filter.shouldIgnore('src/app.ts')).toBe(false);
  });

  it('getExcludePatterns 应返回默认目录、文件及自定义模式', () => {
    const custom = ['*.custom'];
    const patterns = getExcludePatterns(custom);
    expect(patterns).toEqual([
      ...DEFAULT_EXCLUDE_DIRS,
      ...DEFAULT_EXCLUDE_FILE_PATTERNS,
      ...custom,
    ]);
  });
});
