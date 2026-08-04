import type { StdioOptions } from 'node:child_process';

export interface OwnedCommandOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  timeoutMs: number;
  gracePeriodMs?: number;
  signal?: AbortSignal;
}

export interface OwnedCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

export function runOwnedCommand(
  options: OwnedCommandOptions
): Promise<OwnedCommandResult>;
