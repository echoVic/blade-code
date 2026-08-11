export type ProviderStallPhase = 'detected' | 'recovered';

export interface ProviderStallEvent {
  phase: ProviderStallPhase;
  stallCount: number;
  durationMs: number;
  warningAfterMs: number;
  timeoutMs: number;
  outputStarted: boolean;
}
