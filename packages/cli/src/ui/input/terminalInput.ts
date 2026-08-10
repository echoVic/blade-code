import { MAX_USER_MESSAGE_TEXT_CHARS } from '../../api/attachmentLimits.js';

const ESC = '\u001B';
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const INK_BRACKETED_PASTE_START = '[200~';
const INK_BRACKETED_PASTE_END = '[201~';
const TERMINAL_FOCUS_SEQUENCES = [`${ESC}[I`, `${ESC}[O`, '[I', '[O'] as const;

export const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
export const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;
export const DISABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004l`;

const START_MARKERS = [BRACKETED_PASTE_START, INK_BRACKETED_PASTE_START] as const;
const END_MARKERS = [BRACKETED_PASTE_END, INK_BRACKETED_PASTE_END] as const;

export interface TerminalInputParserState {
  pasteBuffer: string | null;
  pasteOverflowed: boolean;
}

export interface TerminalInputSegment {
  kind: 'text' | 'paste';
  text: string;
}

export interface TerminalInputParseResult {
  handled: boolean;
  state: TerminalInputParserState;
  segments: TerminalInputSegment[];
}

interface MarkerMatch {
  index: number;
  marker: string;
}

export function createTerminalInputParserState(): TerminalInputParserState {
  return { pasteBuffer: null, pasteOverflowed: false };
}

function findFirstMarker(
  input: string,
  markers: readonly string[]
): MarkerMatch | undefined {
  let match: MarkerMatch | undefined;
  for (const marker of markers) {
    const index = input.indexOf(marker);
    if (index === -1) continue;
    if (
      !match ||
      index < match.index ||
      (index === match.index && marker.length > match.marker.length)
    ) {
      match = { index, marker };
    }
  }
  return match;
}

function isFocusSequence(input: string): boolean {
  return TERMINAL_FOCUS_SEQUENCES.some((sequence) => input === sequence);
}

export function parseTerminalInput(
  currentState: TerminalInputParserState,
  rawInput: string
): TerminalInputParseResult {
  let input = rawInput;
  let pasteBuffer = currentState.pasteBuffer;
  let pasteOverflowed = currentState.pasteOverflowed;
  let handled = pasteBuffer !== null;
  const segments: TerminalInputSegment[] = [];

  while (input.length > 0) {
    if (pasteBuffer !== null) {
      const end = findFirstMarker(input, END_MARKERS);
      if (!end) {
        if (pasteBuffer.length + input.length > MAX_USER_MESSAGE_TEXT_CHARS) {
          pasteBuffer = '';
          pasteOverflowed = true;
        } else if (!pasteOverflowed) {
          pasteBuffer += input;
        }
        input = '';
        break;
      }

      if (pasteBuffer.length + end.index > MAX_USER_MESSAGE_TEXT_CHARS) {
        pasteOverflowed = true;
      } else if (!pasteOverflowed) {
        pasteBuffer += input.slice(0, end.index);
        segments.push({ kind: 'paste', text: pasteBuffer });
      }
      pasteBuffer = null;
      pasteOverflowed = false;
      handled = true;
      input = input.slice(end.index + end.marker.length);
      continue;
    }

    const start = findFirstMarker(input, START_MARKERS);
    if (!start) {
      if (isFocusSequence(input)) {
        handled = true;
      } else {
        segments.push({ kind: 'text', text: input });
      }
      input = '';
      break;
    }

    const prefix = input.slice(0, start.index);
    if (prefix && !isFocusSequence(prefix)) {
      segments.push({ kind: 'text', text: prefix });
    }
    pasteBuffer = '';
    pasteOverflowed = false;
    handled = true;
    input = input.slice(start.index + start.marker.length);
  }

  if (rawInput.length === 0 && pasteBuffer !== null) {
    handled = true;
  }

  return {
    handled,
    state: { pasteBuffer, pasteOverflowed },
    segments,
  };
}
