import { useRef, useCallback, useEffect } from 'react';
import { PASTE_CONFIG } from '../constants.js';

const PASTE_CHUNK_TIMEOUT_MS = PASTE_CONFIG.TIMEOUT_MS;
const PASTE_MIN_CHARS = PASTE_CONFIG.LARGE_INPUT_THRESHOLD;

type PasteResult = {
  isPaste: boolean;
  text: string;
};

interface PasteState {
  chunks: string[];
  timeoutId: NodeJS.Timeout | null;
  firstInputTime: number | null;
  lastInputTime: number | null;
  totalLength: number;
}

export function usePasteHandler(
  onPaste?: (text: string) => void,
) {
  const chunksRef = useRef<PasteState>({
    chunks: [],
    timeoutId: null,
    firstInputTime: null,
    lastInputTime: null,
    totalLength: 0,
  });

  const flushChunks = useCallback(() => {
    const state = chunksRef.current;
    const combined = state.chunks.join('');
    const totalLength = state.totalLength;

    chunksRef.current = {
      chunks: [],
      timeoutId: null,
      firstInputTime: null,
      lastInputTime: null,
      totalLength: 0,
    };

    if (combined.length >= PASTE_MIN_CHARS && onPaste) {
      onPaste(combined);
    }

    return { combined, totalLength };
  }, [onPaste]);

  const detectPaste = useCallback(
    (input: string): PasteResult => {
      if (input.length > 1 && !input.startsWith('\x1b')) {
        return { isPaste: true, text: input };
      }
      return { isPaste: false, text: input };
    },
    [],
  );

  const handleChunk = useCallback(
    (chunk: string) => {
      chunksRef.current.chunks.push(chunk);
      chunksRef.current.totalLength += chunk.length;

      if (chunksRef.current.timeoutId) {
        clearTimeout(chunksRef.current.timeoutId);
      }

      chunksRef.current.timeoutId = setTimeout(flushChunks, PASTE_CHUNK_TIMEOUT_MS);
    },
    [flushChunks],
  );

  useEffect(() => {
    return () => {
      if (chunksRef.current.timeoutId) {
        clearTimeout(chunksRef.current.timeoutId);
      }
    };
  }, []);

  return {
    detectPaste,
    handleChunk,
    isPending: chunksRef.current.chunks.length > 0,
  };
}
