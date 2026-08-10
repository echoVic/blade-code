import {
  isServiceTierSelection,
  type ServiceTierConfiguration,
  type ServiceTierSelection,
} from '../services/pi/serviceTier.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

function formatConfiguration(configuration: ServiceTierConfiguration): string {
  const resolved =
    configuration.selection === configuration.effective
      ? configuration.selection
      : `${configuration.selection} (${configuration.effective})`;
  return (
    `Service tier: ${resolved}\n` +
    `Supported: auto, ${configuration.supported.join(', ')}`
  );
}

function normalizeSelection(value: string): ServiceTierSelection | undefined {
  const normalized = value.toLowerCase();
  if (normalized === 'on') return 'fast';
  if (normalized === 'off') return 'standard';
  return isServiceTierSelection(normalized) ? normalized : undefined;
}

const speedCommand: SlashCommand = {
  name: 'speed',
  aliases: ['fast'],
  description: '查看或设置当前 Session 的 provider 服务等级',
  fullDescription:
    'auto 使用 provider 默认值；standard 强制基线；fast 使用 priority tier；flex 使用低成本弹性 tier。显式不支持的等级会被拒绝。',
  usage: '/speed [auto|standard|fast|flex]',
  category: 'Session',
  examples: ['/speed', '/speed fast', '/fast on', '/fast off'],
  async handler(args, context): Promise<SlashCommandResult> {
    if (!context.serviceTier) {
      return {
        success: false,
        error: 'This surface has no active Session service-tier boundary',
      };
    }
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /speed [auto|standard|fast|flex]',
      };
    }
    const requested = args[0] ? normalizeSelection(args[0]) : undefined;
    if (args[0] && !requested) {
      return {
        success: false,
        error: `Invalid service tier: ${args[0].toLowerCase()}`,
      };
    }
    try {
      const configuration = requested
        ? await context.serviceTier.set(requested)
        : await context.serviceTier.get();
      return {
        success: true,
        message: formatConfiguration(configuration),
        data: {
          serviceTier: configuration.selection,
          effectiveServiceTier: configuration.effective,
          supportedServiceTiers: configuration.supported,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update service tier',
      };
    }
  },
};

export default speedCommand;
