import { parseReviewTarget } from './review.js';
import type { SlashCommand } from './types.js';
import { getUI } from './types.js';

const securityReviewCommand: SlashCommand = {
  name: 'security-review',
  description: '在独立只读 reviewer 中审查本次改动引入的可利用安全问题',
  usage: '/security-review [uncommitted | base <ref> | commit <sha>]',
  examples: ['/security-review', '/security-review base main'],
  async handler(args, context) {
    if (!context.codeReview) {
      return { success: false, error: '当前入口不支持原生安全审查' };
    }
    try {
      const target = parseReviewTarget(args, 'security-review');
      getUI(context).sendMessage('正在启动独立只读 Security Review…');
      const result = await context.codeReview.run(
        { ...target, mode: 'security' },
        context.signal
      );
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

export default securityReviewCommand;
