import { describe, expect, it } from 'vitest';
import {
  appendBoundedPtyEvidence,
  latchForegroundBoundedPtyMarkers,
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

  it('latches completed markers when later redraw output rotates them away', () => {
    const expected = {
      expected: 'BOUNDED_FOREGROUND_OK',
      stdoutTail: 'STDOUT_TAIL',
      stderrTail: 'STDERR_TAIL',
    };
    const observed = latchForegroundBoundedPtyMarkers(
      {
        sawExpected: false,
        sawStdoutTail: false,
        sawStderrTail: false,
        sawTruncation: false,
      },
      'BOUNDED_FOREGROUND_OK\nOutput truncated\nSTDOUT_TAIL\nSTDERR_TAIL',
      expected
    );

    expect(
      latchForegroundBoundedPtyMarkers(
        observed,
        'later resize redraw without retained stream tails',
        expected
      )
    ).toEqual({
      sawExpected: true,
      sawStdoutTail: true,
      sawStderrTail: true,
      sawTruncation: true,
    });
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
        readerPaused: true,
        renderedAfterReaderResume: true,
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
      readerPaused: true,
      renderedAfterReaderResume: true,
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
        JSON.stringify({
          success: false,
          error: 'resize evidence missing test-secret',
          output: 'failed',
        }),
        ['test-secret']
      )
    ).toThrow(
      'Bounded PTY evidence is incomplete: {"incomplete":["success","sawExpected",' +
        '"sawStdoutTail","sawStderrTail","noticeBeforeResize",' +
        '"noticeAfterResize","readerPaused","renderedAfterReaderResume"],' +
        '"runnerError":"resize evidence missing [REDACTED]"}'
    );
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
          readerPaused: true,
          renderedAfterReaderResume: true,
          output: 'contains-test-secret',
        }),
        ['test-secret']
      )
    ).toThrow('secret');
  });
});
