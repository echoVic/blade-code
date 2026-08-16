import { describe, expect, it } from 'vitest';
import { hasVisibleWeightedProviderRejection } from '../../support/weightedProviderAdmissionPtyDriver.js';

describe('weighted Provider admission PTY evidence', () => {
  it.each([
    'pending_bytes queue is full',
    'Provider queue full',
    'Background subagent execution failed',
    'Child task failed before producing output',
    'Child agent failure',
    '后台子代理执行失败',
    '子任务实际失败了，没有返回内容',
  ])('recognizes a visible rejected child: %s', (output) => {
    expect(hasVisibleWeightedProviderRejection(output)).toBe(true);
  });

  it.each([
    'Blade will wake the parent after background completion.',
    'The child task is still running.',
    'BACKGROUND_PARENT_FINAL:CHILD_MARKER',
  ])('does not infer rejection from unrelated output: %s', (output) => {
    expect(hasVisibleWeightedProviderRejection(output)).toBe(false);
  });
});
