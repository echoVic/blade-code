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
  latestCompleteStandardPtyFrame,
  parseForegroundBoundedOutputPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
  waitForPtyFinalization,
} from '../../support/foregroundBoundedOutputPtyDriver.js';

describe('foreground bounded output PTY driver', () => {
  it('does not treat rendered text as durable completion and obeys the shared deadline', async () => {
    vi.useFakeTimers();
    try {
      let final = { state: 'structural_mismatch', text: 'DONE' };
      let settled = false;
      const promise = waitForPtyFinalization(
        () => final,
        'DONE',
        Date.now() + 200
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      final = { state: 'awaiting_task_completion', text: 'DONE' };
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      final = { state: 'ready', text: 'DONE' };
      await vi.advanceTimersByTimeAsync(50);
      await promise;
      const timeout = waitForPtyFinalization(
        () => ({ state: 'structural_mismatch' }),
        'DONE',
        Date.now() + 50
      );
      const rejection = expect(timeout).rejects.toThrow('durable completion');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      await expect(
        waitForPtyFinalization(
          () => ({ state: 'ready', text: 'WRONG' }),
          'DONE',
          Date.now() + 50
        )
      ).rejects.toThrow('mismatch');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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
    'builds the stable split-field %s final-marker instruction without embedding the marker',
    (_case, marker) => {
      const instruction = createSplitPtyMarkerInstruction(marker);
      const partA = instruction.match(/^PART_A=([A-Za-z0-9_-]+)$/m)?.[1];
      const partB = instruction.match(/^PART_B=([A-Za-z0-9_-]+)$/m)?.[1];

      expect(instruction).not.toContain(marker);
      expect(partA).toBeTypeOf('string');
      expect(partB).toBeTypeOf('string');
      expect(`${partA}${partB}`).toBe(marker);
      expect(instruction).toContain(`exactly ${marker.length} ASCII characters`);
      expect(instruction).toContain(`match ^[A-Za-z0-9_-]{${marker.length}}$`);
      expect(instruction).toContain(
        'Your entire response must be exactly the payload of PART_A immediately ' +
          'followed by the payload of PART_B.'
      );
      expect(instruction).not.toContain('MARKER_TEMPLATE=');
      expect(instruction.endsWith(`PART_A=${partA}\nPART_B=${partB}`)).toBe(true);
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

  it('uses the latest complete standard redraw instead of stale side-panel text', () => {
    const previous = '\u001b[2K\u001b[GAnswering...\nBash active\n\u001b[2A\u001b[5G';
    const current =
      '\u001b[2K\u001b[1A\u001b[2K\u001b[GBash active\ncomposer\n\u001b[1A\u001b[5G';
    expect(latestCompleteStandardPtyFrame(previous + current)).toBe(
      'Bash active\ncomposer\n'
    );
  });

  it('ignores an incomplete redraw rather than claiming the side panel disappeared', () => {
    const previous = '\u001b[2K\u001b[GAnswering...\nBash active\n\u001b[2A\u001b[5G';
    const partial = '\u001b[2K\u001b[G';
    expect(latestCompleteStandardPtyFrame(previous + partial)).toContain(
      'Answering...'
    );
    expect(
      latestCompleteStandardPtyFrame(previous + partial + 'Bash active\n')
    ).toContain('Answering...');
    expect(
      latestCompleteStandardPtyFrame(previous + partial + 'Bash active\n\u001b[5')
    ).toContain('Answering...');
    expect(
      latestCompleteStandardPtyFrame(previous + partial + 'Bash active\n\u001b[5G')
    ).toBe('Bash active\n');
  });

  it('does not accept a cursor-only update or bare text as a complete redraw', () => {
    expect(latestCompleteStandardPtyFrame('Bash active\ncomposer')).toBeUndefined();
    expect(
      latestCompleteStandardPtyFrame('\u001b[1G\u001b[2A\u001b[5G')
    ).toBeUndefined();
  });

  it('retains the panel when the latest complete redraw still contains it', () => {
    const current =
      '\u001b[2K\u001b[G\u001b[36mAnswering...\u001b[0m\r\nBash active\r\n\u001b[2A\u001b[5G';
    expect(latestCompleteStandardPtyFrame(current)).toBe(
      'Answering...\r\nBash active\r\n'
    );
  });

  it('completes redraws without cursor positioning at the next erase sequence', () => {
    const erase = '\u001b[2K\u001b[1A'.repeat(6) + '\u001b[2K\u001b[G';
    const previous = `${erase}Answering...\r\nBash active\r\n`;
    const current =
      '  正在执行 1 个工具 Bash · Esc 取消\r\n\r\n' +
      '╭────────────╮\r\n│ > 输入命令 │\r\n╰────────────╯\r\n' +
      '  yolo mode on · deepseek-v4-flash\r\n';

    expect(latestCompleteStandardPtyFrame(previous + erase + current)).toBe(
      'Answering...\r\nBash active\r\n'
    );
    expect(latestCompleteStandardPtyFrame(previous + erase + current + erase)).toBe(
      current
    );
  });

  it('waits for every byte of a chunked erase boundary before completing a frame', () => {
    const erase = '\u001b[2K\u001b[1A'.repeat(2) + '\u001b[2K\u001b[G';
    const current = 'Bash active\r\ncomposer\r\n';
    const output = erase + current;

    for (let length = 0; length < erase.length; length++) {
      expect(
        latestCompleteStandardPtyFrame(output + erase.slice(0, length))
      ).toBeUndefined();
    }
    expect(latestCompleteStandardPtyFrame(output + erase)).toBe(current);
  });

  it('retains a complete panel frame while the next no-cursor frame is partial', () => {
    const erase = '\u001b[2K\u001b[1A\u001b[2K\u001b[G';
    const panel = '\u001b[36mAnswering...\u001b[0m\r\nBash active\r\n';

    expect(
      latestCompleteStandardPtyFrame(erase + panel + erase + 'Bash active\r\n')
    ).toBe('Answering...\r\nBash active\r\n');
  });

  it('accepts a complete footer-delimited redraw without retaining the previous side panel', () => {
    const footer = /\n[^\r\n]*\d+%\s*·\s*Cache[^\r\n]*\r?\n$/;
    const erase = '\u001b[2K\u001b[G';
    const previous = `${erase}BTW\nSIDE_PAGE_FIRST\n99% · Cache 18%\n`;
    const closed = '│ > MAIN_DRAFT_AFTER_SIDE │\r\n99% · Cache 18%\r\n';

    expect(latestCompleteStandardPtyFrame(previous + erase + closed, footer)).toBe(
      closed
    );
    expect(
      latestCompleteStandardPtyFrame(previous + erase + closed.slice(0, -1), footer)
    ).toContain('BTW');
    expect(
      latestCompleteStandardPtyFrame(
        previous + erase + '│ > MAIN_DRAFT_AFTER_SIDE │\n',
        footer
      )
    ).toContain('BTW');
    expect(latestCompleteStandardPtyFrame(erase + closed, footer)).not.toContain('BTW');
    expect(
      latestCompleteStandardPtyFrame(
        previous + erase + 'BTW\n99% · Cache 18%\n',
        footer
      )
    ).toContain('BTW');
    expect(
      latestCompleteStandardPtyFrame(erase + closed.slice(0, -1), footer)
    ).toBeUndefined();
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
