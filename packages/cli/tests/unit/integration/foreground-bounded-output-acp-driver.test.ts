import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import { inspectForegroundBoundedOutputAcpToolUpdates } from '../../support/foregroundBoundedOutputAcpDriver.js';
import { ChildProcessRecordingAcpClient } from '../../support/acp/ChildProcessRecordingAcpClient.js';

vi.unmock('node:child_process');
vi.unmock('child_process');

import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

describe('child-backed ACP terminal driver', () => {
  it('runs a real Node child terminal for ACP compatibility trajectories', async () => {
    const client = new ChildProcessRecordingAcpClient();
    const created = await client.createTerminal({
      sessionId: 'node-child',
      command: "printf 'stdout-tail'; printf 'stderr-tail' >&2",
    });
    const exit = await client.waitForTerminalExit({
      sessionId: 'node-child',
      terminalId: created.terminalId,
    });
    const output = await client.terminalOutput({
      sessionId: 'node-child',
      terminalId: created.terminalId,
    });
    await client.releaseTerminal({
      sessionId: 'node-child',
      terminalId: created.terminalId,
    });

    expect(exit.exitCode).toBe(0);
    expect(output.output).toContain('stdout-tail');
    expect(output.output).toContain('stderr-tail');
    expect(client.activeTerminalCount()).toBe(0);
  });

  it('requires bounded markers in the terminal update without accepting raw progress', () => {
    const fixture = {
      stdoutPrefixSentinel: 'STDOUT_PREFIX',
      stderrPrefixSentinel: 'STDERR_PREFIX',
      stdoutTail: 'STDOUT_TAIL',
      stderrTail: 'STDERR_TAIL',
    };
    const updates = [
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-1',
          status: 'in_progress',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Executing Bash command...' },
            },
          ],
        },
      },
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-1',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'STDOUT_TAIL\nSTDERR_TAIL\nOutput truncated',
              },
            },
          ],
        },
      },
    ] satisfies acp.SessionNotification[];

    expect(
      inspectForegroundBoundedOutputAcpToolUpdates(updates, 'bash-1', fixture)
    ).toMatchObject({
      finalCount: 1,
      finalStatus: 'completed',
      progressContainsRawOutput: false,
      hasStdoutTail: true,
      hasStderrTail: true,
      hasStdoutPrefix: false,
      hasStderrPrefix: false,
    });

    const leakedProgress = structuredClone(updates);
    leakedProgress[0]!.update.content = [
      {
        type: 'content',
        content: { type: 'text', text: 'STDOUT_PREFIX' },
      },
    ];
    expect(
      inspectForegroundBoundedOutputAcpToolUpdates(leakedProgress, 'bash-1', fixture)
        .progressContainsRawOutput
    ).toBe(true);
  });

  it('runs a real merged PTY lifecycle and releases the handle idempotently', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'blade-acp-child-'));
    const runner = path.resolve(
      import.meta.dirname,
      '../../support/acp/run-child-backed-client-smoke.ts'
    );
    try {
      const result = await execFileAsync('bun', [runner, workspace], {
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      });
      const evidence = JSON.parse(result.stdout) as {
        exitCode: number;
        output: string;
        observed: string;
        processes: Array<{ pid: number; identity: ProcessIdentity }>;
        observedPids: number[];
        releaseCount: number;
        activeTerminalCount: number;
      };

      expect(evidence).toMatchObject({
        exitCode: 0,
        output: 'alpha\nbeta\n',
        observed: 'alpha\nbeta\n',
        releaseCount: 1,
        activeTerminalCount: 0,
      });
      expect(evidence.observedPids).toHaveLength(1);
      expect(evidence.processes).toHaveLength(1);
      expect(
        processIdentityMatches(
          evidence.processes[0]!.pid,
          evidence.processes[0]!.identity
        )
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
