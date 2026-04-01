import { useState, useCallback, useMemo } from 'react';
import type { Suggestion } from './useKeyboardMachine.js';

type SuggestionState =
  | { visible: false }
  | { visible: true; items: Suggestion[]; selectedIndex: number };

export function useSuggestions() {
  const [state, setState] = useState<SuggestionState>({ visible: false });

  const show = useCallback((items: Suggestion[]) => {
    if (items.length === 0) {
      setState({ visible: false });
      return;
    }
    setState({ visible: true, items, selectedIndex: 0 });
  }, []);

  const hide = useCallback(() => {
    setState({ visible: false });
  }, []);

  const selectNext = useCallback(() => {
    setState((prev) => {
      if (!prev.visible) return prev;
      return {
        ...prev,
        selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
      };
    });
  }, []);

  const selectPrev = useCallback(() => {
    setState((prev) => {
      if (!prev.visible) return prev;
      return {
        ...prev,
        selectedIndex: Math.max(prev.selectedIndex - 1, 0),
      };
    });
  }, []);

  const selected = useMemo(() => {
    if (!state.visible) return undefined;
    return state.items[state.selectedIndex];
  }, [state]);

  return {
    state,
    show,
    hide,
    selectNext,
    selectPrev,
    selected,
    items: state.visible ? state.items : [],
    visible: state.visible,
    selectedIndex: state.visible ? state.selectedIndex : -1,
  };
}
