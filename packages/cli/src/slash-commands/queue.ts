import type { SlashCommand } from './types.js';

const queueCommand: SlashCommand = {
  name: 'queue',
  description: 'Inspect and manage the durable follow-up queue',
  fullDescription:
    'Open the local TUI follow-up queue to inspect, remove, and reorder mutable items.',
  usage: '/queue',
  examples: ['/queue'],
  category: 'conversation',

  async handler(args, context) {
    if (args.length > 0) {
      return { success: false, error: 'Usage: /queue' };
    }
    if (
      context.surface !== 'tui' ||
      context.workspaceKind === 'acp-remote' ||
      !context.sessionId
    ) {
      return {
        success: false,
        error: 'Follow-up queue control requires an active local TUI Session',
      };
    }
    return {
      success: true,
      message: 'show_follow_up_queue',
      data: { action: 'show_follow_up_queue' },
    };
  },
};

export default queueCommand;
