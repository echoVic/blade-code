import { describe, expect, it } from 'vitest';
import { parseBackgroundSubagentCompletionPtyEvidence } from '../../support/backgroundSubagentCompletionPtyDriver.js';

describe('background completion PTY evidence', () => {
  it('accepts complete monotonic marker evidence', () => {
    const evidence = parseBackgroundSubagentCompletionPtyEvidence(
      JSON.stringify({
        success: true,
        sawProviderAdmission: true,
        sawChildMarker: true,
        sawParentFinal: true,
        output: 'BACKGROUND_PARENT_FINAL:child',
      })
    );

    expect(evidence.sawParentFinal).toBe(true);
  });

  it('reports missing fields and redacts bounded runner diagnostics', () => {
    let message = '';
    try {
      parseBackgroundSubagentCompletionPtyEvidence(
        JSON.stringify({
          success: false,
          error: 'Provider queue marker missing test-secret',
          output: `${'x'.repeat(9_000)} test-secret tail`,
        }),
        ['test-secret']
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      '"incomplete":["success","sawProviderAdmission","sawChildMarker","sawParentFinal"]'
    );
    expect(message).toContain('[REDACTED]');
    expect(message).toContain('tail');
    expect(message).not.toContain('test-secret');
    expect(message.length).toBeLessThan(9_000);
  });

  it('rejects oversized and credential-bearing successful evidence', () => {
    expect(() =>
      parseBackgroundSubagentCompletionPtyEvidence('x'.repeat(30_001))
    ).toThrow('serialized budget');
    expect(() =>
      parseBackgroundSubagentCompletionPtyEvidence(
        JSON.stringify({
          success: true,
          sawProviderAdmission: true,
          sawChildMarker: true,
          sawParentFinal: true,
          output: 'contains-test-secret',
        }),
        ['test-secret']
      )
    ).toThrow('credentials');
  });
});
