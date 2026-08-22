import type { SlashCommand } from './types.js';

const btwCommand: SlashCommand = {
  name: 'btw',
  description: 'Ask a side question without changing the main conversation',
  fullDescription:
    'Ask one context-aware question in an isolated, tool-free conversation.',
  usage: '/btw <question>',
  category: 'conversation',
  examples: ['/btw What did the last test failure mean?'],

  async handler(args, context) {
    const question = args.join(' ').trim();
    if (!question) {
      return { success: false, error: 'Usage: /btw <question>' };
    }
    if (!context.sideConversation) {
      return {
        success: false,
        error: 'Side conversations require an active Session runtime',
      };
    }

    const result = await context.sideConversation.ask(question, context.signal);
    return {
      success: true,
      content: `**/btw** ${question}\n\n${result.response}`,
      data: {
        action: 'show_side_conversation',
        question,
        response: result.response,
        durationMs: result.durationMs,
        usage: result.usage,
      },
    };
  },
};

export default btwCommand;
