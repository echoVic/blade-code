import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';

vi.unmock('node:child_process');
vi.unmock('child_process');

import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

describe('child-backed ACP terminal driver', () => {
  it(
    'runs a real merged PTY lifecycle and releases the handle idempotently',
    async () => {
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
          processes: Array<{ pid: number; identity: ProcessIdentity }>;
          observedPids: number[];
          releaseCount: number;
          activeTerminalCount: number;
        };

        expect(evidence).toMatchObject({
          exitCode: 0,
          output: 'alpha\nbeta\n',
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
    },
    30_000
  );
});
