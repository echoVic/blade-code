declare module 'react/compiler-runtime' {
  export function c(size: number): any[];
}

declare module 'bidi-js' {
  interface BidiInstance {
    getReorderSegments(
      text: string,
      explicitDirection?: 'ltr' | 'rtl' | 'auto',
    ): Array<[number, number, number]>;
    getMirroredCharacter(char: string): string | null;
    getEmbeddingLevels(
      text: string,
      explicitDirection?: 'ltr' | 'rtl' | 'auto',
    ): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> };
  }
  export default function bidiFactory(): BidiInstance;
}

declare module 'react-reconciler' {
  const createReconciler: any;
  export default createReconciler;
  export type FiberRoot = any;
}

declare module 'react-reconciler/constants.js' {
  export const ConcurrentRoot: number;
  export const LegacyRoot: number;
  export const ContinuousEventPriority: number;
  export const DefaultEventPriority: number;
  export const DiscreteEventPriority: number;
  export const IdleEventPriority: number;
  export const NoEventPriority: number;
}

declare const Bun:
  | {
      env: Record<string, string | undefined>;
      stringWidth?: (str: string, opts?: { ambiguousIsNarrow?: boolean }) => number;
      wrapAnsi?: (input: string, columns: number, options?: Record<string, unknown>) => string;
    }
  | undefined;
