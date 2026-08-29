import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createDurableInteractionRecoveryPtyFinalInstruction,
  parseDurableInteractionRecoveryPtyEvidence,
  parseDurableInteractionRecoveryPtyFailureEvidence,
} from '../../support/durableInteractionRecoveryPtyDriver.js';
import { createSplitPtyMarkerInstruction } from '../../support/foregroundBoundedOutputPtyDriver.js';

vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);

const expectedContent = 'Canary\n';
const expectedSha256 =
  '7a29a06b7f0ece46a22639b9b3d5adef0779cd2fd162ec92d6dbaf80fd484938';

const safeEvidence = {
  success: true,
  sessionId: 'durable-interaction-session',
  questionVisible: true,
  canaryVisible: true,
  reviewVisible: true,
  finalMarkerSeen: true,
  secretSeen: false,
  interactionRequested: 1,
  interactionResponded: 1,
  interactionRecovered: 1,
  writeCalls: 1,
  writeResults: 1,
  inboxMissing: true,
  targetSha256: expectedSha256,
  exitCode: 0,
  exitSignal: null,
  termFallbackUsed: false,
  killFallbackUsed: false,
  output: 'Durable question visible\nFinal marker rendered',
} as const;

describe('durable interaction raw PTY driver', () => {
  it('accepts exact bounded evidence', () => {
    expect(
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(safeEvidence),
        'credential-token',
        expectedContent
      )
    ).toEqual(safeEvidence);
  });

  it.each([
    ['missing flag', { ...safeEvidence, reviewVisible: undefined }],
    ['wrong interaction count', { ...safeEvidence, interactionRecovered: 2 }],
    ['wrong Write count', { ...safeEvidence, writeCalls: 2 }],
    ['wrong Write result count', { ...safeEvidence, writeResults: 0 }],
  ])('rejects %s', (_name, evidence) => {
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(evidence),
        'credential-token',
        expectedContent
      )
    ).toThrow('evidence is incomplete');
  });

  it('rejects oversized evidence', () => {
    const serialized = JSON.stringify({ ...safeEvidence, output: 'x'.repeat(33_000) });

    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        serialized,
        'credential-token',
        expectedContent
      )
    ).toThrow('exceeded its serialized budget');
  });

  it.each([
    ['stdout', { ...safeEvidence, extra: 'provider-secret' }],
    ['output', { ...safeEvidence, output: 'provider-secret' }],
  ])('rejects a secret in %s without echoing it', (_name, evidence) => {
    let error: unknown;
    try {
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(evidence),
        'provider-secret',
        expectedContent
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('contains provider credentials');
    expect((error as Error).message).not.toContain('provider-secret');
  });

  it('rejects unknown keys and a digest unrelated to expected content', () => {
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, unexpected: true }),
        'credential-token',
        expectedContent
      )
    ).toThrow('evidence is incomplete');
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, targetSha256: 'a'.repeat(64) }),
        'credential-token',
        expectedContent
      )
    ).toThrow('target digest mismatch');
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, targetSha256: expectedSha256 }),
        'credential-token',
        expectedContent
      )
    ).not.toThrow();
  });

  it('rejects noncanonical shutdown evidence', () => {
    for (const evidence of [
      { ...safeEvidence, exitCode: 1 },
      { ...safeEvidence, exitSignal: 'SIGTERM' },
      { ...safeEvidence, termFallbackUsed: true },
      { ...safeEvidence, killFallbackUsed: true },
    ]) {
      expect(() =>
        parseDurableInteractionRecoveryPtyEvidence(
          JSON.stringify(evidence),
          'credential-token',
          expectedContent
        )
      ).toThrow('evidence is incomplete');
    }
  });

  it('accepts only bounded structural failure diagnostics', () => {
    const failure = {
      success: false,
      stage: 'completion',
      code: 'qualification_failed',
      reason: 'duplicate_interaction',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: true,
      killFallbackUsed: false,
      snapshot: {
        interactionRequested: '2plus',
        interactionResponded: 1,
        interactionRecovered: 1,
        recoveryToolResults: 1,
        writeCalls: 1,
        writeResults: 1,
        successfulWriteResults: 1,
        turnStarts: 1,
        acknowledgements: 1,
        turnCompleted: 1,
        turnAborted: 0,
        targetState: 'matched',
        inboxMissing: true,
        durableFinalState: 'matched',
        surfaceFinalSeen: true,
        questionVisible: true,
        reviewVisible: true,
        childExitState: 'running',
      },
    } as const;

    expect(
      parseDurableInteractionRecoveryPtyFailureEvidence(JSON.stringify(failure))
    ).toEqual(failure);
    expect(() =>
      parseDurableInteractionRecoveryPtyFailureEvidence(
        JSON.stringify({ ...failure, rawError: 'private' })
      )
    ).toThrow('safe failure evidence is invalid');
    expect(() =>
      parseDurableInteractionRecoveryPtyFailureEvidence(
        JSON.stringify({ ...failure, reason: 'provider-secret' })
      )
    ).toThrow('safe failure evidence is invalid');
  });

  it('builds a split final-marker instruction without embedding the marker', () => {
    const marker = 'DURABLE_PTY_FINAL_123456';
    const instruction = createDurableInteractionRecoveryPtyFinalInstruction(marker);

    expect(instruction).not.toContain(marker);
    expect(instruction).toContain('MARKER_TEMPLATE=');
    expect(instruction).toContain('Delete the one ~ character');
    expect(instruction).not.toBe(createSplitPtyMarkerInstruction(marker));
  });

  it('keeps the durable marker transform on the bounded ASCII contract', () => {
    for (const marker of ['', 'A', 'A'.repeat(129), 'HAS SPACE', 'UNICODE_你好']) {
      expect(() => createDurableInteractionRecoveryPtyFinalInstruction(marker)).toThrow(
        'bounded ASCII contract'
      );
    }
  });

  it('keeps the raw PTY production and keyboard synchronization contract', async () => {
    const supportRoot = path.resolve(import.meta.dirname, '../../support');
    const [driver, runner] = await Promise.all([
      readFile(
        path.join(supportRoot, 'durableInteractionRecoveryPtyDriver.ts'),
        'utf8'
      ),
      readFile(
        path.join(supportRoot, 'durableInteractionRecoveryPtyRunner.ts'),
        'utf8'
      ),
    ]);
    const source = driver + '\n' + runner;

    expect(source).toContain("from 'bun-pty'");
    expect(driver).toContain("'../../dist/blade.js'");
    expect(runner).toContain("'--resume'");
    expect(runner).toContain('input.sessionId');
    expect(runner).toContain("terminal.write('2')");
    expect(runner).toContain("terminal.write('y')");
    expect(runner.match(/terminal\.write\('\\u0004'\)/g)).toHaveLength(2);
    expect(runner).toContain('termFallbackUsed');
    expect(runner).toContain('killFallbackUsed');
    expect(runner).toContain('reviewOutputOffset = plainOutput.length');
    expect(runner).toContain('path.relative(input.workspace, input.target)');
    expect(runner).toContain('Non-canonical durable interaction PTY input encoding');
    const reviewOffset = runner.indexOf('reviewOutputOffset = plainOutput.length');
    const selectCanary = runner.indexOf("terminal.write('2')");
    const waitForReview = runner.indexOf('() => reviewVisible');
    const submitReview = runner.indexOf("terminal.write('y')");
    expect(reviewOffset).toBeGreaterThanOrEqual(0);
    expect(reviewOffset).toBeLessThan(selectCanary);
    expect(selectCanary).toBeLessThan(waitForReview);
    expect(waitForReview).toBeLessThan(submitReview);
    expect(source).not.toContain('agent.chat');
    expect(source).not.toContain('resolvePendingWithHandler');
    expect(driver).not.toContain("killSignal: 'SIGKILL'");
    expect(runner).not.toContain('output.replaceAll');
    expect(runner).not.toContain('error.message,');
    expect(runner).toContain("state: 'invalid'");
    expect(runner).toContain('lastCompletionSnapshot');
  });

  it('returns one structural failure JSON for invalid child input', async () => {
    const runner = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryPtyRunner.ts'
    );
    let stdout = '';
    let stderr = '';
    try {
      await execFileAsync(process.env.BUN_EXEC_PATH ?? 'bun', [runner], {
        env: { ...process.env, BLADE_DURABLE_INTERACTION_PTY_INPUT: 'not-base64' },
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      stdout = String(failure.stdout ?? '');
      stderr = String(failure.stderr ?? '');
    }

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      success: false,
      stage: 'input',
      code: 'invalid_input',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
      reason: 'invalid_input',
      snapshot: null,
    });
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });
});
