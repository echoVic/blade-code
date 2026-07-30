declare module 'node-pty' {
  interface PtyProcess {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number }) => void): void;
  }

  export function spawn(
    command: string,
    args: string[] | string,
    options: {
      name?: string;
      cwd?: string;
      env?: Record<string, string | undefined>;
      cols?: number;
      rows?: number;
    }
  ): PtyProcess;
}
