import type { CodeReviewDispatchInput } from '@/services';

export function parseNativeReviewCommand(
  input: string
): Pick<CodeReviewDispatchInput, 'kind' | 'ref' | 'mode'> | undefined {
  const parts = input.trim().split(/\s+/);
  const command = parts[0];
  if (command !== '/review' && command !== '/security-review') return undefined;
  const kind = parts[1] ?? 'uncommitted';
  if (
    (kind !== 'uncommitted' && kind !== 'base' && kind !== 'commit') ||
    (kind === 'uncommitted' && parts.length > 2) ||
    ((kind === 'base' || kind === 'commit') && parts.length !== 3)
  ) {
    throw new Error(`Usage: ${command} [uncommitted | base <ref> | commit <sha>]`);
  }
  return {
    kind,
    ...(parts[2] ? { ref: parts[2] } : {}),
    ...(command === '/security-review' ? { mode: 'security' } : {}),
  };
}
