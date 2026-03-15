/**
 * stats 命令 - 递归统计当前项目代码行数（按文件扩展名分组）
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { CommandModule } from 'yargs';
import { FileFilter } from '../utils/filePatterns.js';

interface ExtensionStats {
  files: number;
  lines: number;
}

async function collectFiles(
  rootDir: string,
  currentDir: string,
  filter: FileFilter,
  results: string[]
): Promise<void> {
  const entries: Dirent[] = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // 使用 FileFilter 统一处理忽略目录（包含默认排除和 .gitignore 规则）
      if (filter.shouldIgnoreDirectory(relPath) || filter.shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      await collectFiles(rootDir, fullPath, filter, results);
    } else if (entry.isFile()) {
      if (filter.shouldIgnore(relPath)) {
        continue;
      }

      results.push(fullPath);
    }
  }
}

export const statsCommand: CommandModule = {
  command: 'stats',
  describe: 'Show project code statistics by file extension',
  builder: (yargs) =>
    yargs.example([
      ['$0 stats', 'Show code statistics for the current project'],
    ]),
  handler: async () => {
    const cwd = process.cwd();

    console.log('📊 Project code statistics');
    console.log(`📁 Root: ${cwd}`);
    console.log('🔍 Scanning files...');

    try {
      const filter = await FileFilter.create({
        cwd,
        useGitignore: true,
        gitignoreScanMode: 'recursive',
      });

      const files: string[] = [];
      await collectFiles(cwd, cwd, filter, files);

      const stats = new Map<string, ExtensionStats>();
      let totalFiles = 0;
      let totalLines = 0;

      for (const filePath of files) {
        const ext = path.extname(filePath).toLowerCase() || '[no-ext]';

        let content: string;
        try {
          content = await readFile(filePath, 'utf8');
        } catch {
          // 无法读取的文件直接跳过
          continue;
        }

        const lineCount = content === '' ? 0 : content.split(/\r\n|\n|\r/).length;

        totalFiles += 1;
        totalLines += lineCount;

        const stat = stats.get(ext) ?? { files: 0, lines: 0 };
        stat.files += 1;
        stat.lines += lineCount;
        stats.set(ext, stat);
      }

      // 按行数从多到少排序
      const sortedEntries = Array.from(stats.entries()).sort(
        (a, b) => b[1].lines - a[1].lines
      );

      console.log('\n📌 Lines by extension:');
      for (const [ext, stat] of sortedEntries) {
        const label = ext === '[no-ext]' ? '(no extension)' : ext;
        console.log(
          `  ${label.padEnd(14)}  ${stat.lines.toString().padStart(8)} lines  in ${stat.files.toString().padStart(4)} files`
        );
      }

      console.log('\n📦 Summary:');
      console.log(`  Total files: ${totalFiles}`);
      console.log(`  Total lines: ${totalLines}`);
    } catch (error) {
      console.error(
        `❌ Failed to calculate stats: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      process.exit(1);
    }
  },
};

