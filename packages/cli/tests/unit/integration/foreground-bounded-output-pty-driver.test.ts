import { describe, expect, it } from 'vitest';
import {
  appendBoundedPtyEvidence,
  parseForegroundBoundedOutputPtyEvidence,
} from '../../support/foregroundBoundedOutputPtyDriver.js';

describe('foreground bounded output PTY driver', () => {
  it('retains only the latest bounded ANSI evidence', () => {
    const output = appendBoundedPtyEvidence('prefix-', `${'x'.repeat(100)}TAIL`, 16);

    expect(output).toHaveLength(16);
    expect(output).toContain('TAIL');
    expect(output).not.toContain('prefix');
  });

  it('accepts complete resize and marker evidence', () => {
    const evidence = parseForegroundBoundedOutputPtyEvidence(
      JSON.stringify({
        success: true,
        sawExpected: true,
        sawStdoutTail: true,
        sawStderrTail: true,
        noticeBeforeResize: true,
        noticeAfterResize: true,
        output: 'Output truncated\nSTDOUT_TAIL\nSTDERR_TAIL',
      }),
      ['secret-not-present']
    );

    expect(evidence.output).toContain('STDERR_TAIL');
  });

  it('rejects incomplete, oversized, and secret-bearing evidence', () => {
    expect(() =>
      parseForegroundBoundedOutputPtyEvidence(
        JSON.stringify({ success: false, output: 'failed' })
      )
    ).toThrow('incomplete');
    expect(() => parseForegroundBoundedOutputPtyEvidence('x'.repeat(30_001))).toThrow(
      'budget'
    );
    expect(() =>
      parseForegroundBoundedOutputPtyEvidence(
        JSON.stringify({
          success: true,
          sawExpected: true,
          sawStdoutTail: true,
          sawStderrTail: true,
          noticeBeforeResize: true,
          noticeAfterResize: true,
          output: 'contains-test-secret',
        }),
        ['test-secret']
      )
    ).toThrow('secret');
  });
});
