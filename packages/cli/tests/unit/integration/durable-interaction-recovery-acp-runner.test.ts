import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  inspectDurableCompletionLifecycle,
  inspectDurableWriteEvidence,
  parseDurableInteractionRecoveryAcpEvidence,
  parseDurableInteractionRecoveryAcpRunnerInput,
  pollDurableInteractionCompletion,
  serializeDurableInteractionRecoveryAcpEvidence,
  withDurableInteractionStorageRoot,
} from '../../support/durableInteractionRecoveryAcpRunner.js';

vi.unmock('node:child_process');
vi.unmock('child_process');

import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

function eventBase(id: string, type: SessionEvent['type']) {
  return {
    id,
    sessionId: 'durable-acp-session',
    timestamp: '2026-08-29T00:00:00.000Z',
    type,
    cwd: '/tmp/blade/workspace',
    version: 'test',
  };
}

function completionLifecycleEvents(): SessionEvent[] {
  const inboxMessageId = 'interaction-request-1';
  const turnId = 'recovered-turn';
  return [
    {
      ...eventBase('turn-started', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId,
        kind: 'pending',
        startedAt: '2026-08-29T00:00:00.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('inbox-acknowledged', 'inbox_acknowledged'),
      type: 'inbox_acknowledged',
      data: {
        messageIds: [inboxMessageId],
        acknowledgedAt: '2026-08-29T00:00:01.000Z',
      },
    },
    {
      ...eventBase('turn-completed', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId,
        completedAt: '2026-08-29T00:00:02.000Z',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 2_000,
      },
    },
  ];
}

const safeEvidence = {
  success: true,
  sessionId: 'durable-acp-session',
  modeId: 'yolo',
  questionRequests: 1,
  requestMatched: true,
  optionMatched: true,
  interactionRequested: 1,
  interactionResponded: 1,
  interactionRecovered: 1,
  recoveryToolResults: 1,
  writeCalls: 1,
  writeResults: 1,
  inboxMissing: true,
  acpFinalMarkerCount: 1,
  durableFinalMarkerCount: 1,
  targetSha256: 'a'.repeat(64),
  targetBytes: 7,
  sessionClosed: true,
  eofClosed: true,
  childExitCode: 0,
  childExitSignal: null,
  termFallbackUsed: false,
  killFallbackUsed: false,
  secretSeen: false,
} as const;

function encodedInput(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      cliEntry: '/tmp/blade/dist/blade.js',
      workspace: '/tmp/blade/workspace',
      home: '/tmp/blade/home',
      storageRoot: '/tmp/blade/storage',
      sessionId: 'durable-acp-session',
      requestId: 'request-1',
      targetPath: '/tmp/blade/workspace/channel.txt',
      answerLabel: 'Stable',
      expectedContent: 'Stable\n',
      finalMarker: 'ACP_DURABLE_COMPLETE',
      secret: 'provider-secret',
      timeoutMs: 270_000,
      ...overrides,
    }),
    'utf8'
  ).toString('base64');
}

describe('durable interaction ACP stdio runner', () => {
  it('parses only exact bounded success evidence', () => {
    expect(
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify(safeEvidence),
        'provider-secret'
      )
    ).toEqual(safeEvidence);

    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify({ ...safeEvidence, extra: true }),
        'provider-secret'
      )
    ).toThrow('evidence is invalid');
  });

  it.each([
    ['missing field', { ...safeEvidence, optionMatched: undefined }],
    ['wrong interaction count', { ...safeEvidence, interactionResponded: 2 }],
    ['wrong recovery result count', { ...safeEvidence, recoveryToolResults: 0 }],
    ['wrong Write count', { ...safeEvidence, writeCalls: 2 }],
    ['wrong final count', { ...safeEvidence, acpFinalMarkerCount: 0 }],
    ['fallback used', { ...safeEvidence, termFallbackUsed: true }],
  ])('rejects %s', (_name, evidence) => {
    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify(evidence),
        'provider-secret'
      )
    ).toThrow('evidence is invalid');
  });

  it('rejects oversized evidence', () => {
    const serialized = JSON.stringify({
      ...safeEvidence,
      sessionId: 'x'.repeat(17_000),
    });

    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(serialized, 'provider-secret')
    ).toThrow('exceeded its serialized budget');
  });

  it('rejects secret-bearing evidence without echoing the secret', () => {
    const secret = 'provider-secret-material';
    let error: unknown;
    try {
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify({ ...safeEvidence, sessionId: secret }),
        secret
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('contains provider credentials');
    expect((error as Error).message).not.toContain(secret);
  });

  it('credential-gates final evidence after secrets arrive in split chunks', () => {
    const secret = 'provider-secret-material';
    const serialized = serializeDurableInteractionRecoveryAcpEvidence(
      { ...safeEvidence, modeId: secret },
      secret,
      ['provider-secret-', 'material']
    );

    expect(JSON.parse(serialized)).toEqual({
      success: false,
      stage: 'evidence',
      code: 'surface_secret',
      timedOut: false,
      secretSeen: true,
      termFallbackUsed: false,
      killFallbackUsed: false,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized.trim().split(/\r?\n/)).toHaveLength(1);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16 * 1024);
  });

  it.each(['inbox_acknowledged', 'turn_completed'] as const)(
    'fails closed on duplicate recovered %s evidence',
    (type) => {
      const events = completionLifecycleEvents();
      const duplicate = events.find((event) => event.type === type);
      expect(duplicate).toBeDefined();

      expect(() =>
        inspectDurableCompletionLifecycle(
          [...events, { ...duplicate!, id: `duplicate-${type}` }],
          'interaction-request-1'
        )
      ).toThrow('duplicate durable completion evidence');
    }
  );

  it('requires recovered turn start, acknowledgement, and completion in order', () => {
    const events = completionLifecycleEvents();
    expect(
      inspectDurableCompletionLifecycle(events, 'interaction-request-1')
    ).toMatchObject({ turnId: 'recovered-turn' });

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[1]!, events[0]!, events[2]!],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('propagates durable I/O failures immediately instead of timing out', async () => {
    const eio = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    const startedAt = Date.now();

    await expect(
      pollDurableInteractionCompletion({
        deadlineAt: Date.now() + 5_000,
        inspect: async () => {
          throw eio;
        },
        intervalMs: 1,
      })
    ).rejects.toBe(eio);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('fails closed when the durable event count or byte budget is exceeded', () => {
    const events = completionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        Array.from({ length: 4_097 }, (_, index) => ({
          ...events[0]!,
          id: `event-${index}`,
        })),
        'interaction-request-1'
      )
    ).toThrow('durable event budget exceeded');

    expect(() =>
      inspectDurableCompletionLifecycle(
        [{ ...events[0]!, id: 'x'.repeat(2 * 1024 * 1024) }],
        'interaction-request-1'
      )
    ).toThrow('durable event budget exceeded');
  });

  it('rejects an extra failed Write result beside the successful result', () => {
    const writeCallId = 'write-call';
    const part = (
      id: string,
      partType: 'tool_call' | 'tool_result',
      payload: Record<string, unknown>
    ): Extract<SessionEvent, { type: 'part_created' }> => ({
      ...eventBase(id, 'part_created'),
      type: 'part_created',
      data: {
        partId: id,
        messageId: `${id}-message`,
        partType,
        payload: { toolCallId: writeCallId, toolName: 'Write', ...payload },
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    });
    const events = [
      part('write-call', 'tool_call', {
        input: {
          file_path: '/tmp/blade/workspace/channel.txt',
          content: 'Stable\n',
        },
      }),
      part('write-success', 'tool_result', { output: 'written', error: null }),
      part('write-failure', 'tool_result', { output: null, error: 'failed' }),
    ];

    expect(() =>
      inspectDurableWriteEvidence(
        events,
        '/tmp/blade/workspace/channel.txt',
        'Stable\n'
      )
    ).toThrow('duplicate recovery side effect');
  });

  it('restores BLADE_STORAGE_ROOT after success and failure', async () => {
    const original = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = '/tmp/original-storage';
    try {
      await expect(
        withDurableInteractionStorageRoot('/tmp/scoped-storage', async () => {
          expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/scoped-storage');
          return 'ok';
        })
      ).resolves.toBe('ok');
      expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/original-storage');

      await expect(
        withDurableInteractionStorageRoot('/tmp/scoped-storage', async () => {
          expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/scoped-storage');
          throw new Error('expected failure');
        })
      ).rejects.toThrow('expected failure');
      expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/original-storage');
    } finally {
      if (original === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = original;
    }
  });

  it('accepts numeric timeoutMs separately from string settings', () => {
    expect(parseDurableInteractionRecoveryAcpRunnerInput(encodedInput())).toMatchObject(
      {
        timeoutMs: 270_000,
        answerLabel: 'Stable',
      }
    );
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ timeoutMs: '270000' })
      )
    ).toThrow('input is invalid');
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ requestId: undefined })
      )
    ).toThrow('input is invalid');
  });

  it('uses the production CLI SDK stdio lifecycle without an extra prompt', async () => {
    const runnerPath = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryAcpRunner.ts'
    );
    const source = await readFile(runnerPath, 'utf8');

    expect(source).toContain("'/dist/blade.js'");
    expect(source).toContain("spawn(process.execPath, [input.cliEntry, '--acp']");
    expect(source).toContain('new acp.ClientSideConnection');
    expect(source).toContain('acp.ndJsonStream(');
    expect(source).toContain('Writable.toWeb(child.stdin)');
    expect(source).toContain('Readable.toWeb(stdout)');
    expect(source).toContain('connection.loadSession({');
    expect(source).not.toContain('connection.prompt(');
    expect(source).not.toContain('new BladeAgent(');
    expect(source).not.toContain('createMockACPClient');
    expect(source).toContain('connection.closeSession({');
    expect(source).toContain('await endChildInput(child);');
    expect(source.indexOf('connection.closeSession({')).toBeLessThan(
      source.indexOf('await endChildInput(child);')
    );
    const endChildInput = source.slice(
      source.indexOf('function endChildInput('),
      source.indexOf('async function main()')
    );
    expect(endChildInput).toContain('stdin.end(');
    expect(source.match(/process\.stdout\.write\(/g)).toHaveLength(1);
  });

  it('emits one bounded JSON failure record for invalid input', async () => {
    const runnerPath = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryAcpRunner.ts'
    );
    const secret = 'invalid-input-secret';
    let stdout = '';
    let stderr = '';
    try {
      await execFileAsync('bun', [runnerPath], {
        env: {
          ...process.env,
          BLADE_DURABLE_INTERACTION_ACP_INPUT: Buffer.from(secret).toString('base64'),
        },
        timeout: 10_000,
        maxBuffer: 32 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }

    expect(JSON.parse(stdout)).toEqual({
      success: false,
      stage: 'input',
      code: 'invalid_input',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
    });
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(`${stdout}\n${stderr}`).not.toContain(secret);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024);
  });
});
