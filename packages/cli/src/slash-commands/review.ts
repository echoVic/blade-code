import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

function parseTarget(args: string[]): {
  kind: 'uncommitted' | 'base' | 'commit';
  ref?: string;
} {
  const kind = args[0]?.toLowerCase() || 'uncommitted';
  if (kind === 'uncommitted') {
    if (args.length > 1) {
      throw new Error('Usage: /review uncommitted');
    }
    return { kind };
  }
  if (kind === 'base' || kind === 'commit') {
    const ref = args[1]?.trim();
    if (!ref || args.length > 2) {
      throw new Error(`Usage: /review ${kind} <ref>`);
    }
    return { kind, ref };
  }
  throw new Error('Usage: /review [uncommitted | base <ref> | commit <sha>]');
}

const reviewCommand: SlashCommand = {
  name: 'review',
  description: '在独立只读 reviewer 中审查代码改动',
  usage: '/review [uncommitted | base <ref> | commit <sha>]',
  examples: ['/review', '/review base main', '/review commit HEAD'],

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    if (!context.codeReview) {
      return {
        success: false,
        error: '当前入口不支持原生代码审查',
      };
    }
    let target: ReturnType<typeof parseTarget>;
    try {
      target = parseTarget(args);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const ui = getUI(context);
    ui.sendMessage('正在启动独立只读 Code Review…');
    try {
      const result = await context.codeReview.run(target, context.signal);
      return {
        success: result.status === 'completed' || result.status === 'stale',
        content: result.content,
        message: result.content,
        data: {
          reviewId: result.reviewId,
          status: result.status,
          findings: result.findings,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export default reviewCommand;
