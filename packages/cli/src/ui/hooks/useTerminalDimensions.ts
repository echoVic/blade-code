import { useStdout } from 'ink';
import { debounce } from 'lodash-es';
import { useEffect, useState } from 'react';

export interface TerminalDimensions {
  width: number;
  height: number;
}

type TerminalDimension = 'columns' | 'rows';

const DIMENSION_FALLBACKS: Record<TerminalDimension, number> = {
  columns: 80,
  rows: 24,
};

function readDimensions(stdout: NodeJS.WriteStream): TerminalDimensions {
  return {
    width: stdout.columns || 80,
    height: stdout.rows || 24,
  };
}

function sameDimensions(
  current: TerminalDimensions,
  next: TerminalDimensions
): boolean {
  return current.width === next.width && current.height === next.height;
}

function useTerminalValue<T>(
  read: (stdout: NodeJS.WriteStream) => T,
  equals: (current: T, next: T) => boolean,
  debounceMs: number
): T {
  const { stdout } = useStdout();
  const [value, setValue] = useState(() => read(stdout));

  useEffect(() => {
    const updateValue = () => {
      const next = read(stdout);
      setValue((current) => (equals(current, next) ? current : next));
    };
    const debouncedUpdate = debounce(updateValue, debounceMs);

    updateValue();
    stdout.on('resize', debouncedUpdate);
    return () => {
      stdout.off('resize', debouncedUpdate);
      debouncedUpdate.cancel();
    };
  }, [stdout, debounceMs, equals, read]);

  return value;
}

function readWidth(stdout: NodeJS.WriteStream): number {
  return stdout.columns || DIMENSION_FALLBACKS.columns;
}

function readHeight(stdout: NodeJS.WriteStream): number {
  return stdout.rows || DIMENSION_FALLBACKS.rows;
}

export function useTerminalDimension(
  prop: TerminalDimension,
  debounceMs = 200
): number {
  return useTerminalValue(
    prop === 'columns' ? readWidth : readHeight,
    Object.is,
    debounceMs
  );
}

export function useTerminalDimensions(debounceMs = 200): TerminalDimensions {
  return useTerminalValue(readDimensions, sameDimensions, debounceMs);
}
