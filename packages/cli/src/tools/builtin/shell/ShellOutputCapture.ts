import { StringDecoder } from 'node:string_decoder';

import {
  BoundedOutputBuffer,
  FOREGROUND_SHELL_OUTPUT_MAX_BYTES,
} from './BoundedOutputBuffer.js';

export type ShellOutputStream = 'stdout' | 'stderr';

export interface ShellOutputStreamSnapshot {
  content: string;
  totalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  totalChars: number;
  accountingComplete: boolean;
}

export interface ShellOutputCaptureSnapshot {
  stdout: ShellOutputStreamSnapshot;
  stderr: ShellOutputStreamSnapshot;
  terminalOutputMerged: boolean;
}

class StreamOutputCapture {
  private readonly buffer: BoundedOutputBuffer;
  private readonly decoder = new StringDecoder('utf8');
  private totalChars = 0;
  private accountingComplete = true;
  private finished = false;

  constructor(maxBytes: number) {
    this.buffer = new BoundedOutputBuffer(maxBytes);
  }

  append(content: string | Buffer): void {
    if (this.finished) return;

    const raw = typeof content === 'string' ? Buffer.from(content) : content;
    this.buffer.append(raw);
    this.totalChars += this.decoder.write(raw).length;
  }

  markAccountingIncomplete(): void {
    this.accountingComplete = false;
  }

  finish(): void {
    if (this.finished) return;

    this.totalChars += this.decoder.end().length;
    this.finished = true;
  }

  snapshot(): ShellOutputStreamSnapshot {
    const snapshot = this.buffer.peek();
    return {
      content: snapshot.content,
      totalBytes: snapshot.totalBytes,
      retainedBytes: snapshot.retainedBytes,
      omittedBytes: snapshot.omittedBytes,
      totalChars: this.totalChars,
      accountingComplete: this.accountingComplete,
    };
  }
}

export class ShellOutputCapture {
  private readonly stdout: StreamOutputCapture;
  private readonly stderr: StreamOutputCapture;

  constructor(
    maxBytes: number = FOREGROUND_SHELL_OUTPUT_MAX_BYTES,
    private readonly terminalOutputMerged: boolean = false
  ) {
    this.stdout = new StreamOutputCapture(maxBytes);
    this.stderr = new StreamOutputCapture(maxBytes);
  }

  append(stream: ShellOutputStream, content: string | Buffer): void {
    this.streamFor(stream).append(content);
  }

  markAccountingIncomplete(): void {
    this.stdout.markAccountingIncomplete();
    this.stderr.markAccountingIncomplete();
  }

  finish(): void {
    this.stdout.finish();
    this.stderr.finish();
  }

  snapshot(): ShellOutputCaptureSnapshot {
    return {
      stdout: this.stdout.snapshot(),
      stderr: this.stderr.snapshot(),
      terminalOutputMerged: this.terminalOutputMerged,
    };
  }

  private streamFor(stream: ShellOutputStream): StreamOutputCapture {
    return stream === 'stdout' ? this.stdout : this.stderr;
  }
}
