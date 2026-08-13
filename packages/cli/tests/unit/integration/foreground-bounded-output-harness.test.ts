import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createForegroundBoundedOutputFixture,
  FOREGROUND_STREAM_BYTES,
  type ForegroundBoundedOutputFixture,
} from '../../integration/real-api/foregroundBoundedOutputFixture.js';
import {
  assertForegroundBoundedOutputEvidenceSafe,
  assertForegroundBoundedOutputToolTrace,
} from '../../integration/real-api/foregroundBoundedOutputHarness.js';
import type { DurableToolTraceRecord } from '../../integration/real-api/sessionForkTrajectoryHarness.js';

describe('foreground bounded output qualification harness', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function fixture(): Promise<ForegroundBoundedOutputFixture> {
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'blade-foreground-bounded-')
    );
    roots.push(workspace);
    return createForegroundBoundedOutputFixture(workspace, 'unit_nonce');
  }

  it('writes exact per-stream bytes with sentinels in the omitted prefix and nonce tails', async () => {
    const created = await fixture();
    const result = spawnSync(process.execPath, [created.scriptPath], {
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBeInstanceOf(Buffer);
    expect(result.stderr).toBeInstanceOf(Buffer);
    expect(result.stdout.length).toBe(FOREGROUND_STREAM_BYTES);
    expect(result.stderr.length).toBe(FOREGROUND_STREAM_BYTES);
    expect(result.stdout.indexOf(created.stdoutPrefixSentinel)).toBeLessThan(4096);
    expect(result.stderr.indexOf(created.stderrPrefixSentinel)).toBeLessThan(4096);
    expect(result.stdout.toString('utf8')).toContain(created.stdoutTail);
    expect(result.stderr.toString('utf8')).toContain(created.stderrTail);
  });

  it('accepts exact local and ACP durable trace accounting', async () => {
    const created = await fixture();
    const base = {
      toolCallId: 'bash-1',
      toolName: 'Bash',
      input: { command: created.command, run_in_background: false },
      error: null,
    } satisfies Omit<DurableToolTraceRecord, 'output'>;
    const local: DurableToolTraceRecord = {
      ...base,
      output: {
        stdout: created.stdoutTail,
        stderr: created.stderrTail,
        output_truncated: true,
        output_accounting_complete: true,
        stdout_total_bytes: created.stdoutBytes,
        stderr_total_bytes: created.stderrBytes,
        stdout_omitted_bytes: 65_536,
        stderr_omitted_bytes: 65_536,
      },
    };
    const acp: DurableToolTraceRecord = {
      ...base,
      output: {
        stdout: `${created.stdoutTail}\n${created.stderrTail}`,
        stderr: '',
        output_truncated: true,
        output_accounting_complete: true,
        terminal_output_merged: true,
        stdout_total_bytes: created.stdoutBytes + created.stderrBytes,
        stderr_total_bytes: 0,
        stdout_omitted_bytes: 65_536,
        stderr_omitted_bytes: 0,
      },
    };

    expect(() =>
      assertForegroundBoundedOutputToolTrace([local], created, 'local')
    ).not.toThrow();
    expect(() =>
      assertForegroundBoundedOutputToolTrace([acp], created, 'acp')
    ).not.toThrow();
  });

  it('rejects unexpected tools, leaked prefix sentinels, and credentials', async () => {
    const created = await fixture();
    const invalid: DurableToolTraceRecord = {
      toolCallId: 'write-1',
      toolName: 'Write',
      input: { file_path: 'result.txt' },
      output: {},
      error: null,
    };

    expect(() =>
      assertForegroundBoundedOutputToolTrace([invalid], created, 'local')
    ).toThrow('invocation');
    expect(() =>
      assertForegroundBoundedOutputEvidenceSafe(
        { output: created.stdoutPrefixSentinel },
        created,
        []
      )
    ).toThrow('sentinel');
    expect(() =>
      assertForegroundBoundedOutputEvidenceSafe(
        { output: 'test-secret' },
        created,
        ['test-secret']
      )
    ).toThrow('Secret material');
  });
});
