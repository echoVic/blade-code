import { EventEmitter } from 'node:events';
import { runHeadless } from '../../src/commands/headless.js';
import { PermissionMode } from '../../src/config/types.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';

const EVIDENCE_OUTPUT_MAX_CHARS = 64_000;
const BACKPRESSURE_DELAY_MS = 75;

class BackpressuredSink extends EventEmitter {
  private output = '';
  private blocked = false;
  private injected = false;
  private writeDuringBackpressure = false;
  private writeCount = 0;

  write(chunk: string): boolean {
    this.writeCount += 1;
    this.output = `${this.output}${chunk}`.slice(-EVIDENCE_OUTPUT_MAX_CHARS);
    if (this.blocked) this.writeDuringBackpressure = true;
    if (this.injected) return !this.blocked;

    this.injected = true;
    this.blocked = true;
    setTimeout(() => {
      this.blocked = false;
      this.emit('drain');
    }, BACKPRESSURE_DELAY_MS);
    return false;
  }

  evidence() {
    return {
      output: this.output,
      backpressureInjected: this.injected,
      writeDuringBackpressure: this.writeDuringBackpressure,
      writeCount: this.writeCount,
      drainListeners: this.listenerCount('drain'),
      errorListeners: this.listenerCount('error'),
    };
  }
}

export interface ForegroundBoundedOutputHeadlessEvidence {
  sessionId: string;
  exitCode: number;
  stdout: ReturnType<BackpressuredSink['evidence']>;
  stderr: ReturnType<BackpressuredSink['evidence']>;
  markerVisible: boolean;
}

export async function runForegroundBoundedOutputHeadlessDriver(input: {
  workspace: string;
  sessionId: string;
  fixture: ForegroundBoundedOutputFixture;
}): Promise<ForegroundBoundedOutputHeadlessEvidence> {
  const stdout = new BackpressuredSink();
  const stderr = new BackpressuredSink();
  const exitCode = await runWithCwdOverride(input.workspace, () =>
    runHeadless(
      {
        headless: true,
        message: input.fixture.localPrompt,
        sessionId: input.sessionId,
        permissionMode: PermissionMode.YOLO,
        verificationAgent: false,
        maxTurns: 2,
      },
      { stdout, stderr }
    )
  );
  const stdoutEvidence = stdout.evidence();
  const stderrEvidence = stderr.evidence();
  const marker = `BOUNDED_FOREGROUND_OK_${input.fixture.stdoutTail.replace(
    'STDOUT_RETAINED_TAIL_',
    ''
  )}`;
  if (
    exitCode !== 0 ||
    !stdoutEvidence.backpressureInjected ||
    !stderrEvidence.backpressureInjected ||
    stdoutEvidence.writeDuringBackpressure ||
    stderrEvidence.writeDuringBackpressure ||
    stdoutEvidence.drainListeners !== 0 ||
    stderrEvidence.drainListeners !== 0 ||
    stdoutEvidence.errorListeners !== 0 ||
    stderrEvidence.errorListeners !== 0 ||
    !stdoutEvidence.output.includes(marker)
  ) {
    throw new Error(
      `Headless backpressure evidence is invalid: ${JSON.stringify({
        exitCode,
        stdout: {
          ...stdoutEvidence,
          output: stdoutEvidence.output.slice(-1_000),
        },
        stderr: {
          ...stderrEvidence,
          output: stderrEvidence.output.slice(-1_000),
        },
        markerVisible: stdoutEvidence.output.includes(marker),
      })}`
    );
  }

  return {
    sessionId: input.sessionId,
    exitCode,
    stdout: stdoutEvidence,
    stderr: stderrEvidence,
    markerVisible: true,
  };
}
