import { describe, expect, it, vi } from 'vitest';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  assertSplitPtyMarkerInstructionAtEnd,
  createSplitPtyMarkerInstruction,
  isCompleteRawPtyMarkerEvidence,
  latchForegroundBoundedPtyMarkers,
  latchPtyEvidence,
  latchPtyMarker,
  parseForegroundBoundedOutputPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from '../../support/foregroundBoundedOutputPtyDriver.js';

describe('foreground bounded output PTY driver', () => {
  it('arms after prompt echo and latches a split marker across output rotation', () => {
    const marker = 'FINAL_MARKER_123456';
    const latch = new ArmedPtyMarkerLatch(marker);

    latch.observe(`prompt echo ${marker}`);
    expect(latch.seen).toBe(false);

    latch.arm();
    latch.observe('prefix FINAL_MARKER_');
    latch.observe(`123456${'x'.repeat(300_000)}`);
    expect(latch.seen).toBe(true);

    latch.observe('later redraw without the marker');
    expect(latch.seen).toBe(true);
  });

  it.each([
    ['minimum', 'AB'],
    ['odd length', 'FINAL_MARKER_12345'],
    ['hyphenated', 'FINAL_MARKER_deepseek-v4-flash'],
    ['maximum', 'A'.repeat(128)],
  ])(
    'builds a mechanical %s final-marker instruction without embedding the marker',
    (_case, marker) => {
      const instruction = createSplitPtyMarkerInstruction(marker);
      const template = instruction.match(
        /^MARKER_TEMPLATE=([A-Za-z0-9_-]+~[A-Za-z0-9_-]+)$/m
      )?.[1];

      expect(instruction).not.toContain(marker);
      expect(template).toBeTypeOf('string');
      expect(template?.split('~')).toHaveLength(2);
      expect(template?.replace('~', '')).toBe(marker);
      expect(instruction).toContain(`exactly ${marker.length} ASCII characters`);
      expect(instruction).toContain(`match ^[A-Za-z0-9_-]{${marker.length}}$`);
      expect(instruction).toContain('Delete the one ~ character from MARKER_TEMPLATE.');
      expect(instruction).not.toContain('PART_A=');
      expect(instruction).not.toContain('PART_B=');
      expect(instruction.endsWith(`MARKER_TEMPLATE=${template}`)).toBe(true);
    }
  );

  it.each([
    ['', 'empty'],
    ['A', 'short'],
    ['A'.repeat(129), 'long'],
    ['HAS SPACE', 'space'],
    ['HAS"QUOTE', 'quote'],
    ['HAS\nNEWLINE', 'newline'],
    ['UNICODE_你好', 'non-ASCII'],
  ])('rejects a %s marker outside the bounded ASCII contract', (marker) => {
    expect(() => createSplitPtyMarkerInstruction(marker)).toThrow(
      'bounded ASCII contract'
    );
  });

  it('requires the complete split-marker instruction to terminate the prompt', () => {
    const marker = 'FINAL_MARKER_123456';
    const instruction = createSplitPtyMarkerInstruction(marker);

    expect(() =>
      assertSplitPtyMarkerInstructionAtEnd(`prefix\n${instruction}`, marker)
    ).not.toThrow();
    expect(() =>
      assertSplitPtyMarkerInstructionAtEnd(`${instruction}\n`, marker)
    ).toThrow('terminate the prompt');
    expect(() =>
      assertSplitPtyMarkerInstructionAtEnd(`${instruction}\nmore text`, marker)
    ).toThrow('terminate the prompt');
  });

  it('clears the PTY exit deadline on success and timeout', async () => {
    vi.useFakeTimers();
    try {
      await waitForPtyExit(Promise.resolve(), 'unused timeout', 100);
      expect(vi.getTimerCount()).toBe(0);

      const timedOut = waitForPtyExit(
        new Promise<void>(() => undefined),
        'PTY exit deadline',
        100
      );
      const rejection = expect(timedOut).rejects.toThrow('PTY exit deadline');
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts only complete safe raw PTY marker evidence', () => {
    expect(
      isCompleteRawPtyMarkerEvidence({
        finalMarkerSeen: true,
        secretSeen: false,
      })
    ).toBe(true);
    expect(isCompleteRawPtyMarkerEvidence({ secretSeen: false })).toBe(false);
    expect(
      isCompleteRawPtyMarkerEvidence({
        finalMarkerSeen: false,
        secretSeen: false,
      })
    ).toBe(false);
    expect(isCompleteRawPtyMarkerEvidence({ finalMarkerSeen: true })).toBe(false);
    expect(
      isCompleteRawPtyMarkerEvidence({
        finalMarkerSeen: true,
        secretSeen: true,
      })
    ).toBe(false);
    expect(isCompleteRawPtyMarkerEvidence(null)).toBe(false);
  });

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

  it('keeps a generic marker true after bounded output rotates', () => {
    const observed = latchPtyMarker(false, 'visible marker', 'visible marker');

    expect(latchPtyMarker(observed, 'later redraw', 'visible marker')).toBe(true);
  });

  it('keeps predicate evidence true after a later redraw no longer matches', () => {
    const observed = latchPtyEvidence(false, true);

    expect(latchPtyEvidence(observed, false)).toBe(true);
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
