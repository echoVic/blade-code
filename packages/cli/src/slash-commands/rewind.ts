/**
 * /rewind — 回退文件到上一次编辑前的状态
 *
 * 利用 SnapshotManager 的文件快照实现时间旅行。
 * 用法：/rewind [file_path]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import { getState } from '../store/vanilla.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

async function listSnapshots(sessionId: string): Promise<Array<{
  filePath: string;
  version: number;
  snapshotPath: string;
  mtime: Date;
}>> {
  const snapshotDir = path.join(getBladeStorageRoot(), 'file-history', sessionId);
  const results: Array<{ filePath: string; version: number; snapshotPath: string; mtime: Date }> = [];

  try {
    const files = await fs.readdir(snapshotDir);
    for (const file of files) {
      const match = file.match(/^(.+)@v(\d+)$/);
      if (!match) continue;
      const fullPath = path.join(snapshotDir, file);
      const stat = await fs.stat(fullPath);
      results.push({
        filePath: match[1],
        version: parseInt(match[2], 10),
        snapshotPath: fullPath,
        mtime: stat.mtime,
      });
    }
  } catch {
    // Directory doesn't exist
  }

  return results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

const rewindCommand: SlashCommand = {
  name: 'rewind',
  description: 'Revert files to their state before the last edit',
  fullDescription: '回退文件到编辑前的快照状态。不带参数列出可回退的文件，带文件路径则执行回退。',
  usage: '/rewind [file_path]',
  aliases: ['undo'],
  async handler(
    args: string[],
    context: SlashCommandContext,
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const state = getState();
    const sessionId = state.session?.sessionId;

    if (!sessionId) {
      ui.sendMessage('无活跃会话，无法查找快照。');
      return { success: false, message: 'No active session' };
    }

    const snapshots = await listSnapshots(sessionId);

    if (snapshots.length === 0) {
      ui.sendMessage('当前会话没有可回退的文件快照。');
      return { success: true, message: 'No snapshots available' };
    }

    if (args.length === 0) {
      const uniqueFiles = new Map<string, { version: number; mtime: Date }>();
      for (const s of snapshots) {
        if (!uniqueFiles.has(s.filePath)) {
          uniqueFiles.set(s.filePath, { version: s.version, mtime: s.mtime });
        }
      }

      let output = '**可回退的文件快照：**\n\n';
      for (const [hash, info] of uniqueFiles) {
        output += `- \`${hash}\` (v${info.version}, ${info.mtime.toLocaleTimeString()})\n`;
      }
      output += '\n使用 `/rewind <file_path>` 回退指定文件。';
      ui.sendMessage(output);
      return { success: true, message: `${uniqueFiles.size} snapshots available` };
    }

    const targetPath = args[0];
    const matching = snapshots.filter((s) => {
      return s.filePath === targetPath || targetPath.endsWith(s.filePath) || s.filePath.endsWith(targetPath);
    });

    if (matching.length === 0) {
      ui.sendMessage(`未找到文件 "${targetPath}" 的快照。`);
      return { success: false, message: 'Snapshot not found' };
    }

    const latest = matching[0];

    try {
      const snapshotContent = await fs.readFile(latest.snapshotPath, 'utf-8');
      await fs.writeFile(targetPath, snapshotContent, 'utf-8');
      ui.sendMessage(`已回退 \`${targetPath}\` 到 v${latest.version} (${latest.mtime.toLocaleTimeString()})`);
      return { success: true, message: `Reverted ${targetPath}` };
    } catch (error) {
      ui.sendMessage(`回退失败: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  },
};

export default rewindCommand;
