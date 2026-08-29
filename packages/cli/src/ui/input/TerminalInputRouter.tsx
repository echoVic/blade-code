import { type Key, useInput as useInkInput } from 'ink';
import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

export type TerminalInputHandler = (input: string, key: Key) => boolean | void;

interface TerminalInputRegistration {
  id: number;
  priority: number;
  handler: TerminalInputHandler;
}

interface TerminalInputRouterApi {
  register: (
    handler: TerminalInputHandler,
    priority: number,
    onRegistered?: () => void
  ) => () => void;
}

interface TerminalInputOptions {
  isActive?: boolean;
  priority?: number;
  onRegistered?: () => void;
}

const TerminalInputRouterContext = createContext<TerminalInputRouterApi | null>(null);

export function TerminalInputRouterProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const registrationsRef = useRef(new Map<number, TerminalInputRegistration>());
  const nextIdRef = useRef(0);

  const register = useCallback(
    (
      handler: TerminalInputHandler,
      priority: number,
      onRegistered?: () => void
    ): (() => void) => {
      const id = nextIdRef.current++;
      registrationsRef.current.set(id, { id, priority, handler });
      onRegistered?.();
      return () => {
        registrationsRef.current.delete(id);
      };
    },
    []
  );

  const api = useMemo<TerminalInputRouterApi>(() => ({ register }), [register]);

  useInkInput((input, key) => {
    const registrations = [...registrationsRef.current.values()].sort(
      (left, right) => right.priority - left.priority || left.id - right.id
    );
    for (const registration of registrations) {
      if (registration.handler(input, key) === true) {
        break;
      }
    }
  });

  return (
    <TerminalInputRouterContext.Provider value={api}>
      {children}
    </TerminalInputRouterContext.Provider>
  );
}

/**
 * Registers one logical input handler with the process-wide router.
 * The Ink fallback keeps isolated component tests and standalone renderers working.
 */
export function useTerminalInput(
  handler: TerminalInputHandler,
  options: TerminalInputOptions = {}
): void {
  const router = useContext(TerminalInputRouterContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const isActive = options.isActive ?? true;
  const priority = options.priority ?? 0;
  const onRegisteredRef = useRef(options.onRegistered);
  onRegisteredRef.current = options.onRegistered;

  useInkInput(
    (input, key) => {
      if (!router && isActive) {
        handlerRef.current(input, key);
      }
    },
    { isActive: !router && isActive }
  );

  useEffect(() => {
    if (!router || !isActive) return;
    return router.register(
      (input, key) => handlerRef.current(input, key),
      priority,
      () => onRegisteredRef.current?.()
    );
  }, [isActive, priority, router]);
}
