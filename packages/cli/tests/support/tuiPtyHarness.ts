import { spawn } from 'bun-pty';

type TuiPty = ReturnType<typeof spawn>;

interface TuiPtyExit {
  exitCode: number;
}

interface TuiPtyHarnessOptions {
  cliEntry: string;
  workspace: string;
  args: string[];
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  signal?(terminal: TuiPty, signal: NodeJS.Signals): void;
}

export interface TuiPtyHarness {
  terminal: TuiPty;
  exit: Promise<TuiPtyExit>;
  close(): Promise<void>;
}

async function exitsWithin(
  exit: Promise<TuiPtyExit>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createTuiPtyHarness(options: TuiPtyHarnessOptions): TuiPtyHarness {
  const terminal = spawn('/usr/bin/env', ['node', options.cliEntry, ...options.args], {
    name: 'xterm-256color',
    cwd: options.workspace,
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    env: options.env,
  });
  const exit = new Promise<TuiPtyExit>((resolve) => terminal.onExit(resolve));
  let closePromise: Promise<void> | undefined;
  const signal = (value: NodeJS.Signals) =>
    options.signal ? options.signal(terminal, value) : terminal.kill(value);

  return {
    terminal,
    exit,
    close() {
      closePromise ??= (async () => {
        terminal.write('\u0004');
        if (await exitsWithin(exit, 500)) return;
        signal('SIGTERM');
        if (await exitsWithin(exit, 2_000)) return;
        signal('SIGKILL');
        await exitsWithin(exit, 2_000);
      })();
      return closePromise;
    },
  };
}
