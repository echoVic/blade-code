import { describe, expect, it } from 'vitest';
import {
  appendBoundedPtyEvidence,
  parseForegroundBoundedOutputPtyEvidence,
  projectForegroundBoundedPtyOutput,
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

  it('bounds ANSI-rich terminal output before serializing evidence', () => {
    const ansiOutput =
      '\u001B[31m' + 'x'.repeat(24_000) + '\u001B[0m\nSTDOUT_TAIL\nSTDERR_TAIL';
    const output = projectForegroundBoundedPtyOutput(ansiOutput);
    const serialized = JSON.stringify({
      success: true,
      sawExpected: true,
      sawStdoutTail: true,
      sawStderrTail: true,
      noticeBeforeResize: true,
      noticeAfterResize: true,
      output,
    });

    expect(output).not.toContain('\u001B[');
    expect(output).toContain('STDOUT_TAIL');
    expect(output).toContain('STDERR_TAIL');
    expect(serialized.length).toBeLessThan(30_000);
    expect(() => parseForegroundBoundedOutputPtyEvidence(serialized)).not.toThrow();
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
