/**
 * /rewind — 回退文件到 Blade 最近一次成功编辑前的状态
 *
 * 用法：/rewind [file_path]
 */

import path from 'node:path';
import { getState } from '../store/vanilla.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { SnapshotManager } from '../tools/builtin/file/SnapshotManager.js';
import { PathSecurity } from '../utils/pathSecurity.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

const rewindCommand: SlashCommand = {
  name: 'rewind',
  description: 'Revert a file to its state before the last Blade edit',
  fullDescription:
    '回退文件到 Blade 最近一次成功编辑前的状态。不带参数列出当前工作区可回退文件。',
  usage: '/rewind [file_path]',
  aliases: ['undo'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const sessionId = context.sessionId ?? getState().session?.sessionId;

    if (!sessionId) {
      ui.sendMessage('无活跃会话，无法查找快照。');
      return { success: false, message: 'No active session' };
    }

    const workspaceRoot = path.resolve(context.workspaceRoot ?? context.cwd);
    const snapshotManager = new SnapshotManager({ sessionId });

    try {
      await snapshotManager.initialize();

      if (args.length === 0) {
        const snapshots = await snapshotManager.listAllSnapshots();
        const latestByFile = new Map<string, (typeof snapshots)[number]>();

        for (const snapshot of snapshots.slice().reverse()) {
          if (
            !latestByFile.has(snapshot.filePath) &&
            (await PathSecurity.isWithinWorkspaceResolved(
              snapshot.filePath,
              workspaceRoot
            ))
          ) {
            latestByFile.set(snapshot.filePath, snapshot);
          }
        }

        if (latestByFile.size === 0) {
          ui.sendMessage('当前会话在这个工作区没有可回退的文件快照。');
          return { success: true, message: 'No snapshots available' };
        }

        let output = '**可回退的文件快照：**\n\n';
        for (const [filePath, snapshot] of latestByFile) {
          const displayPath = path.relative(workspaceRoot, filePath) || '.';
          output += `- \`${displayPath}\` (v${snapshot.version}, ${snapshot.timestamp.toLocaleTimeString()})\n`;
        }
        output += '\n使用 `/rewind <file_path>` 回退指定文件。';
        ui.sendMessage(output);
        return { success: true, message: `${latestByFile.size} snapshots available` };
      }

      const targetPath = path.resolve(context.cwd, args.join(' '));
      if (!(await PathSecurity.isWithinWorkspaceResolved(targetPath, workspaceRoot))) {
        const error = `目标路径不在当前工作区内: ${targetPath}`;
        ui.sendMessage(error);
        return { success: false, error };
      }

      const restored = await snapshotManager.rewindLatest(targetPath);
      FileAccessTracker.getInstance().clearFileRecord(restored.filePath);

      const displayPath = path.relative(workspaceRoot, targetPath) || '.';
      ui.sendMessage(
        `已回退 \`${displayPath}\` 到 Blade 编辑前的状态 (v${restored.version})`
      );
      return { success: true, message: `Reverted ${displayPath}` };
    } catch (error) {
      const message = (error as Error).message;
      ui.sendMessage(`回退失败: ${message}`);
      return { success: false, error: message };
    }
  },
};

export default rewindCommand;
