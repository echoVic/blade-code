import { vi } from 'vitest';
import { EventEmitter } from 'events';

export interface MockTerminalOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandExecution {
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

export class MockTerminal extends EventEmitter {
  private options: MockTerminalOptions;
  private commandHistory: CommandExecution[] = [];
  private outputBuffer: string[] = [];
  private isRunning = false;
  private currentCommand: string | null = null;
  private mockResponses: Map<string, { output: string; exitCode: number }> = new Map();

  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;

  constructor(options: MockTerminalOptions = {}) {
    super();
    this.options = options;
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || {};
  }

  write(data: string): void {
    this.outputBuffer.push(data);
    this.emit('data', data);
  }

  async execute(command: string): Promise<CommandExecution> {
    this.isRunning = true;
    this.currentCommand = command;

    const mockResponse =
      this.mockResponses.get(command) || this.getDefaultResponse(command);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const execution: CommandExecution = {
      command,
      output: mockResponse.output,
      exitCode: mockResponse.exitCode,
      timestamp: Date.now(),
    };

    this.commandHistory.push(execution);
    this.write(mockResponse.output);

    this.isRunning = false;
    this.currentCommand = null;
    this.emit('exit', mockResponse.exitCode);

    return execution;
  }

  private getDefaultResponse(command: string): { output: string; exitCode: number } {
    if (command.startsWith('echo ')) {
      return { output: command.slice(5) + '\n', exitCode: 0 };
    }
    if (command === 'pwd') {
      return { output: this.cwd + '\n', exitCode: 0 };
    }
    if (command.startsWith('cd ')) {
      const newDir = command.slice(3);
      this.cwd = newDir;
      return { output: '', exitCode: 0 };
    }
    if (command === 'ls') {
      return { output: 'file1.txt\nfile2.txt\ndir1/\n', exitCode: 0 };
    }
    if (command.includes('&&')) {
      return { output: 'Commands executed\n', exitCode: 0 };
    }
    return { output: `Mock output for: ${command}\n`, exitCode: 0 };
  }

  setMockResponse(command: string, output: string, exitCode = 0): void {
    this.mockResponses.set(command, { output, exitCode });
  }

  setMockResponsePattern(
    pattern: RegExp,
    handler: (cmd: string) => { output: string; exitCode: number }
  ): void {
    const originalGet = this.mockResponses.get.bind(this.mockResponses);
    this.mockResponses.get = (key: string) => {
      if (pattern.test(key)) {
        return handler(key);
      }
      return originalGet(key);
    };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.emit('resize', { cols, rows });
  }

  kill(signal?: string): void {
    if (this.isRunning) {
      this.isRunning = false;
      this.currentCommand = null;
      this.emit('exit', signal === 'SIGKILL' ? 137 : 143);
    }
  }

  clear(): void {
    this.outputBuffer = [];
    this.emit('clear');
  }

  getOutput(): string {
    return this.outputBuffer.join('');
  }

  getCommandHistory(): CommandExecution[] {
    return [...this.commandHistory];
  }

  getLastCommand(): CommandExecution | undefined {
    return this.commandHistory[this.commandHistory.length - 1];
  }

  isCommandRunning(): boolean {
    return this.isRunning;
  }

  getCurrentCommand(): string | null {
    return this.currentCommand;
  }

  reset(): void {
    this.commandHistory = [];
    this.outputBuffer = [];
    this.isRunning = false;
    this.currentCommand = null;
    this.mockResponses.clear();
  }
}

export const createMockTerminal = (options?: MockTerminalOptions): MockTerminal => {
  return new MockTerminal(options);
};

export const createMockPty = (options?: MockTerminalOptions) => {
  const terminal = new MockTerminal(options);

  return {
    onData: vi.fn((callback: (data: string) => void) => {
      terminal.on('data', callback);
      return { dispose: () => terminal.off('data', callback) };
    }),
    onExit: vi.fn((callback: (exitCode: number) => void) => {
      terminal.on('exit', callback);
      return { dispose: () => terminal.off('exit', callback) };
    }),
    write: vi.fn(terminal.write.bind(terminal)),
    resize: vi.fn(terminal.resize.bind(terminal)),
    kill: vi.fn(terminal.kill.bind(terminal)),
    pid: 12345,
    cols: terminal.cols,
    rows: terminal.rows,
    process: 'mock-shell',
    _terminal: terminal,
  };
};
