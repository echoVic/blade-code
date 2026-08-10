import {
  type CommunicationStyleConfiguration,
  type CommunicationStyleSelection,
  isCommunicationStyleSelection,
} from '../services/communicationStyle.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

function formatConfiguration(configuration: CommunicationStyleConfiguration): string {
  const resolved =
    configuration.selection === configuration.effective
      ? configuration.selection
      : `${configuration.selection} (${configuration.effective})`;
  return `Communication style: ${resolved}\nSupported: ${configuration.supported
    .map((style) => style.id)
    .join(', ')}`;
}

function normalizeSelection(value: string): CommunicationStyleSelection | undefined {
  const normalized = value.toLowerCase();
  return isCommunicationStyleSelection(normalized) ? normalized : undefined;
}

const styleCommand: SlashCommand = {
  name: 'style',
  aliases: ['personality'],
  description: '查看或设置当前 Session 的沟通风格',
  fullDescription: '内置或 namespaced custom style 只改变沟通语气和解释框架。',
  usage: '/style [auto|pragmatic|friendly|explanatory|<namespaced-id>]',
  category: 'Session',
  examples: [
    '/style',
    '/style pragmatic',
    '/style project:review:strict',
    '/personality friendly',
  ],
  async handler(args, context): Promise<SlashCommandResult> {
    if (!context.communicationStyle) {
      return {
        success: false,
        error: 'This surface has no active Session communication-style boundary',
      };
    }
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /style [auto|pragmatic|friendly|explanatory|<namespaced-id>]',
      };
    }
    const requested = args[0] ? normalizeSelection(args[0]) : undefined;
    if (args[0] && !requested) {
      return {
        success: false,
        error: `Invalid communication style: ${args[0].toLowerCase()}`,
      };
    }
    try {
      const configuration = requested
        ? await context.communicationStyle.set(requested)
        : await context.communicationStyle.get();
      return {
        success: true,
        message: formatConfiguration(configuration),
        data: {
          communicationStyle: configuration.selection,
          effectiveCommunicationStyle: configuration.effective,
        },
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update communication style',
      };
    }
  },
};

export default styleCommand;
