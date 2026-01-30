/**
 * 自定义命令加载器
 *
 * 扫描指定目录，发现并加载所有自定义命令
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CustomCommandParser } from './CustomCommandParser.js';
import type {
  CommandSearchDir,
  CustomCommand,
  CustomCommandDiscoveryResult,
} from './types.js';

export class CustomCommandLoader {
  private parser = new CustomCommandParser();

  /**
   * 发现所有自定义命令
   *
   * 按优先级从低到高扫描目录，后面的命令覆盖前面的同名命令
   *
   * 优先级顺序（从低到高）:
   * 1. ~/.blade/commands/ (用户级 Blade)
   * 2. ~/.claude/commands/ (用户级 Claude Code 兼容)
   * 3. .blade/commands/ (项目级 Blade)
   * 4. .claude/commands/ (项目级 Claude Code 兼容)
   */
  async discover(workspaceRoot: string): Promise<CustomCommandDiscoveryResult> {
    const commands: CustomCommand[] = [];
    const scannedDirs: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    // 获取搜索目录（按优先级从低到高排序）
    const searchDirs = this.getSearchDirs(workspaceRoot);

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir.path)) {
        continue;
      }

      scannedDirs.push(dir.path);

      try {
        const files = await this.scanDirectory(dir.path);

        for (const file of files) {
          try {
            const cmd = this.parser.parse(file, dir.path, dir.source, dir.sourceDir);
            if (cmd) {
              commands.push(cmd);
            }
          } catch (error) {
            errors.push({
              path: file,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        errors.push({
          path: dir.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { commands, scannedDirs, errors };
  }

  /**
   * 获取搜索目录列表
   * 按优先级从低到高排序
   */
  private getSearchDirs(workspaceRoot: string): CommandSearchDir[] {
    const homeDir = os.homedir();

    return [
      // 用户级目录（优先级较低）
      {
        path: path.join(homeDir, '.blade', 'commands'),
        source: 'user' as const,
        sourceDir: 'blade' as const,
      },
      {
        path: path.join(homeDir, '.claude', 'commands'),
        source: 'user' as const,
        sourceDir: 'claude' as const,
      },
      // 项目级目录（优先级较高）
      {
        path: path.join(workspaceRoot, '.blade', 'commands'),
        source: 'project' as const,
        sourceDir: 'blade' as const,
      },
      {
        path: path.join(workspaceRoot, '.claude', 'commands'),
        source: 'project' as const,
        sourceDir: 'claude' as const,
      },
    ];
  }

  /**
   * 递归扫描目录下所有 .md 文件
   */
  private async scanDirectory(dirPath: string): Promise<string[]> {
    const results: string[] = [];

    const scan = async (currentPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    };

    await scan(dirPath);
    return results;
  }

  /**
   * 检查指定目录是否存在命令文件
   */
  async hasCommands(workspaceRoot: string): Promise<boolean> {
    const searchDirs = this.getSearchDirs(workspaceRoot);

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir.path)) {
        continue;
      }

      const files = await this.scanDirectory(dir.path);
      if (files.length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取命令目录路径
   */
  getCommandDirs(workspaceRoot: string): {
    projectBlade: string;
    projectClaude: string;
    userBlade: string;
    userClaude: string;
  } {
    const homeDir = os.homedir();

    return {
      projectBlade: path.join(workspaceRoot, '.blade', 'commands'),
      projectClaude: path.join(workspaceRoot, '.claude', 'commands'),
      userBlade: path.join(homeDir, '.blade', 'commands'),
      userClaude: path.join(homeDir, '.claude', 'commands'),
    };
  }
}
