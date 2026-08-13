import { describe, expect, it } from 'vitest';

import type { ShellOutputCaptureSnapshot } from '../../../../../../src/tools/builtin/shell/ShellOutputCapture.js';
import { projectShellOutput } from '../../../../../../src/tools/builtin/shell/ShellOutputProjection.js';

describe('projectShellOutput', () => {
  it('labels omitted earliest output and preserves both retained tails', () => {
    const snapshot = makeCaptureSnapshot({
      stdout: { content: 'STDOUT_TAIL', omittedBytes: 65_536 },
      stderr: { content: 'STDERR_TAIL', omittedBytes: 65_536 },
    });

    const projected = projectShellOutput(snapshot, 'node fixture.mjs');

    expect(projected.stdout).toContain('STDOUT_TAIL');
    expect(projected.stderr).toContain('STDERR_TAIL');
    expect(projected.stdout).not.toContain('STDOUT_PREFIX');
    expect(projected.stderr).not.toContain('STDERR_PREFIX');
    expect(projected.captureTruncated).toBe(true);
    expect(projected.truncationInfo).toContain('earliest');
    expect(projected.truncationInfo).toContain('retained tail');
    expect(projected.truncationInfo).toContain('stdout');
    expect(projected.truncationInfo).toContain('stderr');
  });

  it('records independent stdout and stderr projection facts without capture omission', () => {
    const projected = projectShellOutput(
      makeCaptureSnapshot({
        stdout: { content: longOutput('stdout') },
        stderr: { content: longOutput('stderr') },
      }),
      'git rm -r --cached test'
    );

    expect(projected.captureTruncated).toBe(false);
    expect(projected.projectionTruncated).toBe(true);
    expect(projected.stdoutProjectionTruncated).toBe(true);
    expect(projected.stderrProjectionTruncated).toBe(true);
    expect(projected.truncationInfo).toContain('stdout:');
    expect(projected.truncationInfo).toContain('stderr:');
  });

  it('combines capture omission and projection truncation in one bounded notice', () => {
    const projected = projectShellOutput(
      makeCaptureSnapshot({
        stdout: { content: longOutput('stdout'), omittedBytes: 65_536 },
        stderr: { content: longOutput('stderr') },
      }),
      'git rm -r --cached test'
    );

    expect(projected.captureTruncated).toBe(true);
    expect(projected.projectionTruncated).toBe(true);
    expect(projected.truncationInfo?.match(/Output truncated:/g)).toHaveLength(1);
    expect(projected.truncationInfo).toContain('earliest');
    expect(projected.truncationInfo).toContain('stdout:');
    expect(projected.truncationInfo).toContain('stderr:');
  });

  it('trims short retained output without changing the canonical snapshot', () => {
    const snapshot = makeCaptureSnapshot({
      stdout: { content: '  stdout  ' },
      stderr: { content: '  stderr  ' },
    });

    const projected = projectShellOutput(snapshot, 'node fixture.mjs');

    expect(projected.stdout).toBe('stdout');
    expect(projected.stderr).toBe('stderr');
    expect(projected.truncationInfo).toBeUndefined();
    expect(projected.captureTruncated).toBe(false);
    expect(projected.projectionTruncated).toBe(false);
    expect(projected.stdoutProjectionTruncated).toBe(false);
    expect(projected.stderrProjectionTruncated).toBe(false);
    expect(projected.snapshot).toBe(snapshot);
    expect(snapshot).toEqual(
      makeCaptureSnapshot({
        stdout: { content: '  stdout  ' },
        stderr: { content: '  stderr  ' },
      })
    );
  });

  it('keeps stream projection flags independent when only stdout is truncated', () => {
    const projected = projectShellOutput(
      makeCaptureSnapshot({
        stdout: { content: longOutput('stdout') },
        stderr: { content: 'short stderr' },
      }),
      'git rm -r --cached test'
    );

    expect(projected.stdoutProjectionTruncated).toBe(true);
    expect(projected.stderrProjectionTruncated).toBe(false);
    expect(projected.projectionTruncated).toBe(true);
    expect(projected.stderr).toBe('short stderr');
  });
});

function makeCaptureSnapshot(overrides: {
  stdout?: Partial<ShellOutputCaptureSnapshot['stdout']>;
  stderr?: Partial<ShellOutputCaptureSnapshot['stderr']>;
  terminalOutputMerged?: boolean;
}): ShellOutputCaptureSnapshot {
  const stream = (
    override: Partial<ShellOutputCaptureSnapshot['stdout']> | undefined
  ): ShellOutputCaptureSnapshot['stdout'] => {
    const content = override?.content ?? '';
    const omittedBytes = override?.omittedBytes ?? 0;
    const retainedBytes = override?.retainedBytes ?? Buffer.byteLength(content);

    return {
      content,
      totalBytes: override?.totalBytes ?? retainedBytes + omittedBytes,
      retainedBytes,
      omittedBytes,
      totalChars: override?.totalChars ?? content.length,
      accountingComplete: override?.accountingComplete ?? true,
    };
  };

  return {
    stdout: stream(overrides.stdout),
    stderr: stream(overrides.stderr),
    terminalOutputMerged: overrides.terminalOutputMerged ?? false,
  };
}

function longOutput(stream: string): string {
  return Array.from({ length: 100 }, (_, index) => `${stream}-${index}`).join('\n');
}
