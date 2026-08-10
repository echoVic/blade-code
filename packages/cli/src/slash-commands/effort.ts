import {
  isReasoningEffortSelection,
  type ReasoningEffortConfiguration,
} from '../services/pi/reasoningEffort.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

function formatConfiguration(configuration: ReasoningEffortConfiguration): string {
  const resolved =
    configuration.selection === configuration.effective
      ? configuration.selection
      : `${configuration.selection} (${configuration.effective})`;
  return (
    `Reasoning effort: ${resolved}\n` +
    `Supported: auto, ${configuration.supported.join(', ')}`
  );
}

const effortCommand: SlashCommand = {
  name: 'effort',
  description: '查看或设置当前 Session 的推理强度',
  fullDescription:
    '推理强度由当前 Session 持有并持久化。auto 会按模型能力在 high 附近解析；显式不支持的级别会被拒绝。',
  usage: '/effort [auto|off|minimal|low|medium|high|xhigh|max]',
  category: 'Session',
  examples: ['/effort', '/effort low', '/effort auto', '/effort off'],
  async handler(args, context): Promise<SlashCommandResult> {
    if (!context.reasoning) {
      return {
        success: false,
        error: 'This surface has no active Session reasoning boundary',
      };
    }
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /effort [auto|off|minimal|low|medium|high|xhigh|max]',
      };
    }
    const requested = args[0]?.toLowerCase();
    if (requested !== undefined && !isReasoningEffortSelection(requested)) {
      return {
        success: false,
        error: `Invalid reasoning effort: ${requested}`,
      };
    }
    try {
      const configuration = requested
        ? await context.reasoning.set(requested)
        : await context.reasoning.get();
      return {
        success: true,
        message: formatConfiguration(configuration),
        data: {
          reasoningEffort: configuration.selection,
          effectiveReasoningEffort: configuration.effective,
          supportedReasoningEfforts: configuration.supported,
        },
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to update reasoning effort',
      };
    }
  },
};

export default effortCommand;
