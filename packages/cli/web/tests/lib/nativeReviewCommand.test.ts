import { describe, expect, it } from 'vitest';
import { parseNativeReviewCommand } from '@/lib/nativeReviewCommand';

describe('native review command routing', () => {
  it('routes security review to the security API mode', () => {
    expect(parseNativeReviewCommand('/security-review base main')).toEqual({
      kind: 'base',
      ref: 'main',
      mode: 'security',
    });
    expect(parseNativeReviewCommand('/security-review')).toEqual({
      kind: 'uncommitted',
      mode: 'security',
    });
  });

  it('preserves general review and ordinary task input', () => {
    expect(parseNativeReviewCommand('/review commit HEAD')).toEqual({
      kind: 'commit',
      ref: 'HEAD',
    });
    expect(parseNativeReviewCommand('implement a review feature')).toBeUndefined();
    expect(parseNativeReviewCommand('/security-review-extra')).toBeUndefined();
  });

  it('rejects incomplete targets and extra arguments', () => {
    expect(() => parseNativeReviewCommand('/security-review base')).toThrow();
    expect(() =>
      parseNativeReviewCommand('/security-review uncommitted extra')
    ).toThrow();
  });
});
