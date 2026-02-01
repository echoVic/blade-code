declare module 'bun-pty' {
  export function spawn(
    command: string,
    args: string[],
    options: {
      name?: string;
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
    }
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: (exitInfo: { exitCode: number }) => void): void;
  };
}
