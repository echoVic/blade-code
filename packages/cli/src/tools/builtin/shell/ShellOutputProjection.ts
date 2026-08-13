import { OutputTruncator } from './OutputTruncator.js';
import type { ShellOutputCaptureSnapshot } from './ShellOutputCapture.js';

export interface ProjectedShellOutput {
  stdout: string;
  stderr: string;
  truncationInfo?: string;
  captureTruncated: boolean;
  projectionTruncated: boolean;
  stdoutProjectionTruncated: boolean;
  stderrProjectionTruncated: boolean;
  snapshot: ShellOutputCaptureSnapshot;
}

export function projectShellOutput(
  capture: ShellOutputCaptureSnapshot,
  command: string
): ProjectedShellOutput {
  const stdout = OutputTruncator.truncate(capture.stdout.content.trim(), command);
  const stderr = OutputTruncator.truncate(capture.stderr.content.trim(), command);
  const captureTruncated =
    capture.stdout.omittedBytes > 0 || capture.stderr.omittedBytes > 0;
  const projectionTruncated = stdout.truncated || stderr.truncated;
  const truncationInfo = buildTruncationInfo(capture, stdout, stderr);

  return {
    stdout: stdout.content,
    stderr: stderr.content,
    truncationInfo,
    captureTruncated,
    projectionTruncated,
    stdoutProjectionTruncated: stdout.truncated,
    stderrProjectionTruncated: stderr.truncated,
    snapshot: capture,
  };
}

function buildTruncationInfo(
  capture: ShellOutputCaptureSnapshot,
  stdout: ReturnType<typeof OutputTruncator.truncate>,
  stderr: ReturnType<typeof OutputTruncator.truncate>
): string | undefined {
  const parts: string[] = [];

  for (const [name, stream] of [
    ['stdout', capture.stdout],
    ['stderr', capture.stderr],
  ] as const) {
    if (stream.omittedBytes > 0) {
      parts.push(
        `${name}: omitted ${stream.omittedBytes} bytes from earliest output; retained tail shown`
      );
    }
  }

  for (const [name, result] of [
    ['stdout', stdout],
    ['stderr', stderr],
  ] as const) {
    if (result.truncated) {
      parts.push(
        `${name}: ${result.originalLines} lines -> ${result.content.split('\n').length} lines`
      );
    }
  }

  return parts.length > 0 ? `Output truncated: ${parts.join('; ')}` : undefined;
}
