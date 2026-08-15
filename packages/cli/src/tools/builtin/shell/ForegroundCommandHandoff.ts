import {
  splitCompoundCommand,
  stripSafeEnvVars,
  stripSafeWrappers,
} from '../../../utils/shell/commandNormalizer.js';

export function isForegroundCommandHandoffEligible(input: {
  command: string;
  timeoutMs: number;
  handoffMs: number;
  sessionId?: string;
  readOnlyAudit: boolean;
}): boolean {
  if (
    !input.sessionId ||
    input.readOnlyAudit ||
    input.handoffMs <= 0 ||
    input.timeoutMs <= input.handoffMs
  ) {
    return false;
  }

  const normalized = stripSafeEnvVars(stripSafeWrappers(input.command.trim()));
  const first = splitCompoundCommand(normalized)?.[0] ?? normalized;
  return !/^sleep(?:[ \t]|$)/.test(first.trim());
}
