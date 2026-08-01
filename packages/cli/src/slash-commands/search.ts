/**
 * /search — 历史会话搜索
 *
 * 在过去的 session 历史中搜索关键词，帮助用户回忆过去做过的事情。
 */

import {
  formatSearchResults,
  searchTranscripts,
} from '../services/TranscriptSearch.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';

const searchCommand: SlashCommand = {
  name: 'search',
  description: 'Search past session transcripts',
  fullDescription: '搜索历史会话记录，查找过去的对话内容',
  usage: '/search <keyword>',
  aliases: ['find', 'history'],
  category: 'Session',
  examples: [
    '/search 断路器 - 搜索包含"断路器"的历史对话',
    '/search edit tool - 搜索 edit tool 相关讨论',
  ],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);

    if (args.length === 0) {
      ui.sendMessage(
        '**用法:** `/search <关键词>`\n\n在历史会话中搜索包含指定关键词的对话'
      );
      return { success: true, message: '显示帮助' };
    }

    const query = args.join(' ');
    ui.sendMessage(`正在搜索: "${query}" ...`);

    try {
      const matches = await searchTranscripts(query, {
        maxResults: 15,
        projectPath: context.cwd,
      });

      const result = formatSearchResults(matches);
      ui.sendMessage(result);

      return {
        success: true,
        message: `found ${matches.length} results`,
        data: { matches: matches.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误';
      ui.sendMessage(`搜索失败: ${msg}`);
      return { success: false, error: msg };
    }
  },
};

export default searchCommand;
