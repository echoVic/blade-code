import {
  isResponseVerbositySelection,
  type ResponseVerbosityConfiguration,
  type ResponseVerbositySelection,
} from '../services/pi/responseVerbosity.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

function formatConfiguration(configuration: ResponseVerbosityConfiguration): string {
  const resolved =
    configuration.selection === configuration.effective
      ? configuration.selection
      : `${configuration.selection} (${configuration.effective})`;
  const supported =
    configuration.supported.length > 0
      ? `auto, ${configuration.supported.join(', ')}`
      : 'auto';
  return `Response verbosity: ${resolved}\nSupported: ${supported}`;
}

function normalizeSelection(value: string): ResponseVerbositySelection | undefined {
  const normalized = value.toLowerCase();
  return isResponseVerbositySelection(normalized) ? normalized : undefined;
}

const verbosityCommand: SlashCommand = {
  name: 'verbosity',
  aliases: ['detail'],
  description: '查看或设置当前 Session 的响应详略',
  fullDescription:
    'auto 使用模型默认值；low、medium、high 控制支持模型的原生响应详略。显式不支持的选择会被拒绝。',
  usage: '/verbosity [auto|low|medium|high]',
  category: 'Session',
  examples: ['/verbosity', '/verbosity low', '/detail high'],
  async handler(args, context): Promise<SlashCommandResult> {
    if (!context.responseVerbosity) {
      return {
        success: false,
        error: 'This surface has no active Session response-verbosity boundary',
      };
    }
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /verbosity [auto|low|medium|high]',
      };
    }
    const requested = args[0] ? normalizeSelection(args[0]) : undefined;
    if (args[0] && !requested) {
      return {
        success: false,
        error: `Invalid response verbosity: ${args[0].toLowerCase()}`,
      };
    }
    try {
      const configuration = requested
        ? await context.responseVerbosity.set(requested)
        : await context.responseVerbosity.get();
      return {
        success: true,
        message: formatConfiguration(configuration),
        data: {
          responseVerbosity: configuration.selection,
          effectiveResponseVerbosity: configuration.effective,
          supportedResponseVerbosities: configuration.supported,
        },
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update response verbosity',
      };
    }
  },
};

export default verbosityCommand;
