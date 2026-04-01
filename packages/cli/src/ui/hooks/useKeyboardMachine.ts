import { useReducer } from 'react';

export type Suggestion = {
  label: string;
  value: string;
  description?: string;
};

type InputMode =
  | { kind: 'idle' }
  | { kind: 'suggesting'; index: number; items: Suggestion[] }
  | { kind: 'browsing-history'; index: number }
  | { kind: 'completing-at'; query: string };

type InputEvent =
  | { type: 'KEY_UP' }
  | { type: 'KEY_DOWN' }
  | { type: 'KEY_ESCAPE' }
  | { type: 'KEY_TAB' }
  | { type: 'KEY_ENTER'; value: string }
  | { type: 'SUGGEST'; items: Suggestion[] }
  | { type: 'AT_COMPLETE'; query: string }
  | { type: 'RESET' };

function inputReducer(state: InputMode, action: InputEvent): InputMode {
  switch (state.kind) {
    case 'idle':
      switch (action.type) {
        case 'SUGGEST':
          return action.items.length > 0
            ? { kind: 'suggesting', index: 0, items: action.items }
            : state;
        case 'AT_COMPLETE':
          return { kind: 'completing-at', query: action.query };
        case 'KEY_UP':
          return { kind: 'browsing-history', index: 0 };
        default:
          return state;
      }

    case 'suggesting':
      switch (action.type) {
        case 'KEY_DOWN':
          return {
            ...state,
            index: Math.min(state.index + 1, state.items.length - 1),
          };
        case 'KEY_UP':
          return state.index > 0
            ? { ...state, index: state.index - 1 }
            : { kind: 'idle' };
        case 'KEY_TAB':
        case 'KEY_ENTER':
          return { kind: 'idle' };
        case 'KEY_ESCAPE':
        case 'RESET':
          return { kind: 'idle' };
        case 'SUGGEST':
          return action.items.length > 0
            ? { kind: 'suggesting', index: 0, items: action.items }
            : { kind: 'idle' };
        default:
          return state;
      }

    case 'browsing-history':
      switch (action.type) {
        case 'KEY_UP':
          return { ...state, index: state.index + 1 };
        case 'KEY_DOWN':
          return state.index > 0
            ? { ...state, index: state.index - 1 }
            : { kind: 'idle' };
        case 'KEY_ESCAPE':
        case 'RESET':
          return { kind: 'idle' };
        case 'KEY_ENTER':
          return { kind: 'idle' };
        default:
          return state;
      }

    case 'completing-at':
      switch (action.type) {
        case 'KEY_ESCAPE':
        case 'RESET':
          return { kind: 'idle' };
        case 'KEY_TAB':
        case 'KEY_ENTER':
          return { kind: 'idle' };
        case 'AT_COMPLETE':
          return { ...state, query: action.query };
        default:
          return state;
      }
  }
}

export function useKeyboardMachine() {
  const [mode, dispatch] = useReducer(inputReducer, {
    kind: 'idle',
  } as InputMode);

  return {
    mode,
    dispatch,
    isIdle: mode.kind === 'idle',
    isSuggesting: mode.kind === 'suggesting',
    isBrowsingHistory: mode.kind === 'browsing-history',
    isCompletingAt: mode.kind === 'completing-at',
    selectedSuggestion:
      mode.kind === 'suggesting' ? mode.items[mode.index] : undefined,
  };
}
