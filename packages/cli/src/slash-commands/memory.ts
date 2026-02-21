/**
 * /memory 斜杠命令 - 管理项目 Auto Memory
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { AutoMemoryManager } from '../memory/AutoMemoryManager.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';

/**
 * 用 $EDITOR 打开文件编辑，阻塞直到编辑器关闭
 */
function openInEditor(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const child = spawn(editor, [filePath], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Manage project auto memory',
  fullDescription: '查看和管理项目的 Auto Memory（跨会话持久记忆）',
  usage: '/memory [list|show|edit|clear]',
  aliases: ['mem'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const cwd = process.cwd();
    const manager = new AutoMemoryManager(cwd);
    const subcommand = args[0] || 'list';

    switch (subcommand) {
      case 'list': {
        const topics = await manager.listTopics();
        if (topics.length === 0) {
          ui.sendMessage(
            '📭 暂无记忆文件。Agent 在工作过程中会自动记录有价值的项目知识。\n\n' +
              `📁 记忆目录: ${manager.getMemoryDir()}`
          );
        } else {
          const list = topics
            .map((t) => {
              const sizeKB = (t.size / 1024).toFixed(1);
              const date = t.lastModified.toLocaleDateString('zh-CN');
              const isIndex = t.name === 'MEMORY';
              return `${isIndex ? '📌' : '📄'} **${t.name}.md** — ${sizeKB}KB, ${date}`;
            })
            .join('\n');
          ui.sendMessage(
            `🧠 **项目记忆文件:**\n\n${list}\n\n` +
              `💡 使用 \`/memory edit [topic]\` 编辑，\`/memory show [topic]\` 查看\n` +
              `📁 ${manager.getMemoryDir()}`
          );
        }
        return { success: true, message: '记忆列表已显示' };
      }

      case 'show': {
        const topic = args[1] || 'MEMORY';
        const content = await manager.readTopic(topic);
        if (content === null) {
          ui.sendMessage(`❌ 记忆文件 "${topic}.md" 不存在`);
        } else {
          ui.sendMessage(`📄 **${topic}.md:**\n\n${content}`);
        }
        return { success: true, message: '记忆内容已显示' };
      }

      case 'edit': {
        const topic = args[1] || 'MEMORY';
        const filePath = path.join(manager.getMemoryDir(), `${topic}.md`);

        // 确保 memory 目录和文件存在
        await manager.initialize();
        const content = await manager.readTopic(topic);
        if (content === null) {
          // 创建空文件以便编辑
          await manager.writeTopic(topic, '', 'overwrite');
        }

        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        ui.sendMessage(`📝 正在用 ${editor} 打开 ${topic}.md ...`);

        const success = await openInEditor(filePath);
        if (success) {
          ui.sendMessage(`✅ ${topic}.md 编辑完成`);
        } else {
          ui.sendMessage(
            `⚠️ 编辑器退出异常。你可以手动编辑:\n${filePath}\n\n` +
              `💡 设置 EDITOR 环境变量来指定编辑器（如 export EDITOR=code）`
          );
        }
        return { success: true, message: '编辑完成' };
      }

      case 'clear': {
        const count = await manager.clearAll();
        ui.sendMessage(`🗑️ 已清除 ${count} 个记忆文件`);
        return { success: true, message: `已清除 ${count} 个记忆文件` };
      }

      default: {
        ui.sendMessage(
          `🧠 **Auto Memory 命令:**\n\n` +
            `/memory list — 列出所有记忆文件\n` +
            `/memory show [topic] — 查看记忆内容（默认 MEMORY）\n` +
            `/memory edit [topic] — 用编辑器打开记忆文件（默认 MEMORY）\n` +
            `/memory clear — 清空所有记忆`
        );
        return { success: true, message: '帮助信息已显示' };
      }
    }
  },
};

export default memoryCommand;
