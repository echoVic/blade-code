import { describe, expect, it } from 'vitest';
import { MAX_USER_MESSAGE_TEXT_CHARS } from '../../../../../src/api/attachmentLimits.js';
import {
  createTerminalInputParserState,
  parseTerminalInput,
} from '../../../../../src/ui/input/terminalInput.js';

describe('terminal input parser', () => {
  it('passes ordinary multi-character input through unchanged', () => {
    const result = parseTerminalInput(
      createTerminalInputParserState(),
      '! printf TUI_INPUT_OK'
    );

    expect(result).toEqual({
      handled: false,
      state: { pasteBuffer: null, pasteOverflowed: false },
      segments: [{ kind: 'text', text: '! printf TUI_INPUT_OK' }],
    });
  });

  it('drops standalone terminal focus reports without matching literal text', () => {
    for (const sequence of ['\u001B[I', '\u001B[O', '[I', '[O']) {
      expect(
        parseTerminalInput(createTerminalInputParserState(), sequence)
      ).toMatchObject({
        handled: true,
        segments: [],
      });
    }

    expect(
      parseTerminalInput(createTerminalInputParserState(), 'value[Ikept').segments
    ).toEqual([{ kind: 'text', text: 'value[Ikept' }]);
  });

  it('extracts a complete Ink-normalized bracketed paste payload', () => {
    const result = parseTerminalInput(
      createTerminalInputParserState(),
      '[200~! printf PASTE_OK\r\n[201~'
    );

    expect(result).toEqual({
      handled: true,
      state: { pasteBuffer: null, pasteOverflowed: false },
      segments: [{ kind: 'paste', text: '! printf PASTE_OK\r\n' }],
    });
  });

  it('reassembles bracketed paste markers split across stdin chunks', () => {
    const started = parseTerminalInput(createTerminalInputParserState(), '[200~');
    const continued = parseTerminalInput(started.state, 'line one\r\nline two');
    const completed = parseTerminalInput(continued.state, '[201~');

    expect(started).toMatchObject({
      handled: true,
      state: { pasteBuffer: '', pasteOverflowed: false },
      segments: [],
    });
    expect(continued).toMatchObject({
      handled: true,
      state: {
        pasteBuffer: 'line one\r\nline two',
        pasteOverflowed: false,
      },
      segments: [],
    });
    expect(completed).toEqual({
      handled: true,
      state: { pasteBuffer: null, pasteOverflowed: false },
      segments: [{ kind: 'paste', text: 'line one\r\nline two' }],
    });
  });

  it('preserves text surrounding a complete bracketed paste', () => {
    const result = parseTerminalInput(
      createTerminalInputParserState(),
      `before\u001B[200~pasted\u001B[201~after`
    );

    expect(result.segments).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'paste', text: 'pasted' },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('discards an oversized unterminated paste until its end marker', () => {
    const started = parseTerminalInput(createTerminalInputParserState(), '[200~');
    const overflowed = parseTerminalInput(
      started.state,
      'x'.repeat(MAX_USER_MESSAGE_TEXT_CHARS + 1)
    );
    const discarded = parseTerminalInput(overflowed.state, 'still discarded');
    const completed = parseTerminalInput(discarded.state, '[201~after');

    expect(overflowed).toMatchObject({
      handled: true,
      state: { pasteBuffer: '', pasteOverflowed: true },
      segments: [],
    });
    expect(discarded).toMatchObject({
      handled: true,
      state: { pasteBuffer: '', pasteOverflowed: true },
      segments: [],
    });
    expect(completed).toEqual({
      handled: true,
      state: { pasteBuffer: null, pasteOverflowed: false },
      segments: [{ kind: 'text', text: 'after' }],
    });
  });
});
