import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextManager } from '../../../../src/context/ContextManager.js';
import { parseSessionJSONL } from '../../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import {
  findCurrentTokenBudgetHandoff,
  type TokenBudgetHandoffRecordedV1,
} from '../../../../src/context/TokenBudgetHandoff.js';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../../../src/context/types.js';

const payload = {
  version: 1,
  observedPromptTokens: 75_000,
  availableForInput: 100_000,
  handoffThreshold: 70_000,
  compactionThreshold: 80_000,
} satisfies Omit<TokenBudgetHandoffRecordedV1, 'messageId' | 'createdAt'>;

function rawHandoffEvent(
  sessionId: string,
  workspace: string,
  id: string,
  data: TokenBudgetHandoffRecordedEvent['data']
): TokenBudgetHandoffRecordedEvent {
  return {
    id,
    sessionId,
    projectPath: workspace,
    timestamp: '2026-08-19T08:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: workspace,
    version: 'test',
    data,
  };
}

describe('durable token-budget handoff persistence', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-handoff-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-handoff-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  async function readEvents(sessionId: string): Promise<SessionEvent[]> {
    const filePath = getSessionFilePath(workspace, sessionId);
    return parseSessionJSONL(await readFile(filePath, 'utf8'), filePath);
  }

  it('commits one authority when two facades race on the same real transcript', async () => {
    const sessionId = 'handoff-race';
    const first = new PersistentStore(workspace, 100, 'test');
    const second = new PersistentStore(workspace, 100, 'test');
    await first.initSession(sessionId);

    const results = await Promise.all([
      first.recordTokenBudgetHandoff(sessionId, payload),
      second.recordTokenBudgetHandoff(sessionId, payload),
    ]);
    const events = await readEvents(sessionId);
    const recorded = events.filter(
      (event) => event.type === 'token_budget_handoff_recorded'
    );

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'created',
      'existing',
    ]);
    expect(results.every((result) => result.outcome !== 'suppressed')).toBe(true);
    const identities = results.flatMap((result) =>
      result.outcome === 'suppressed' ? [] : [result.event.data.messageId]
    );
    expect(new Set(identities).size).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.id).not.toBe(recorded[0]?.data.messageId);
  });

  it('opens a new epoch only after a valid replacement checkpoint', async () => {
    const sessionId = 'handoff-epochs';
    const persistent = new PersistentStore(workspace, 100, 'test');

    const first = await persistent.recordTokenBudgetHandoff(sessionId, payload);
    await persistent.saveCompaction(sessionId, 'invalid checkpoint', {
      trigger: 'auto',
      reason: 'threshold',
      strategy: 'llm',
      preTokens: 80_000,
      postTokens: 10_000,
    });
    const afterInvalid = await persistent.recordTokenBudgetHandoff(sessionId, payload);
    await persistent.saveCompaction(sessionId, 'valid checkpoint', {
      trigger: 'auto',
      reason: 'threshold',
      strategy: 'llm',
      preTokens: 80_000,
      postTokens: 10_000,
      replacementMessages: [{ role: 'system', content: 'replacement context' }],
    });
    const afterValid = await persistent.recordTokenBudgetHandoff(sessionId, payload);

    expect(first.outcome).toBe('created');
    expect(afterInvalid.outcome).toBe('existing');
    expect(afterValid.outcome).toBe('created');
    expect(
      (await readEvents(sessionId)).filter(
        (event) => event.type === 'token_budget_handoff_recorded'
      )
    ).toHaveLength(2);
  });

  it.each([
    [
      'future',
      {
        ...payload,
        version: 2,
        messageId: 'future-message',
        createdAt: '2026-08-19T08:00:00.000Z',
      },
    ],
    [
      'malformed',
      { ...payload, messageId: 'malformed-message', createdAt: 'not-an-iso-date' },
    ],
  ])('fails closed for a %s raw record in the current epoch', async (_label, data) => {
    const sessionId = `handoff-${_label}`;
    const persistent = new PersistentStore(workspace, 100, 'test');
    await persistent.initSession(sessionId);
    const filePath = getSessionFilePath(workspace, sessionId);
    const raw = rawHandoffEvent(sessionId, workspace, `raw-${_label}`, data);
    await appendFile(filePath, `${JSON.stringify(raw)}\n`, 'utf8');
    const before = await readFile(filePath, 'utf8');

    await expect(
      persistent.recordTokenBudgetHandoff(sessionId, payload)
    ).resolves.toEqual({
      outcome: 'suppressed',
      recordId: `raw-${_label}`,
    });
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('fails closed when the current epoch contains duplicate raw records', async () => {
    const sessionId = 'handoff-duplicate';
    const persistent = new PersistentStore(workspace, 100, 'test');
    const created = await persistent.recordTokenBudgetHandoff(sessionId, payload);
    if (created.outcome !== 'created') throw new Error('Expected first authority');
    const duplicate = rawHandoffEvent(
      sessionId,
      workspace,
      'raw-duplicate',
      created.event.data
    );
    const filePath = getSessionFilePath(workspace, sessionId);
    await appendFile(filePath, `${JSON.stringify(duplicate)}\n`, 'utf8');
    const before = await readFile(filePath, 'utf8');

    await expect(
      persistent.recordTokenBudgetHandoff(sessionId, payload)
    ).resolves.toEqual({
      outcome: 'suppressed',
      recordId: 'raw-duplicate',
    });
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('classifies the effective epoch and exposes the ContextManager facade', async () => {
    const sessionId = 'handoff-context-manager';
    const manager = new ContextManager({ projectPath: workspace });
    const created = await manager.recordTokenBudgetHandoff(sessionId, payload);
    if (created.outcome === 'suppressed') throw new Error('Expected valid authority');

    expect(findCurrentTokenBudgetHandoff(await readEvents(sessionId))).toEqual({
      kind: 'valid',
      event: created.event,
    });
  });
});
