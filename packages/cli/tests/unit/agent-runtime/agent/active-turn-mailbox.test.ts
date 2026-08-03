import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnMailbox } from '../../../../src/agent/runtime/ActiveTurnMailbox.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../../src/context/storage/pathUtils.js';

describe('ActiveTurnMailbox', () => {
  let storageRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-steering-inbox-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function createMailbox(sessionId = 'session-1') {
    return ActiveTurnMailbox.create(workspaceRoot, sessionId);
  }

  it('accepts steering only for an active turn and drains it in order', async () => {
    const mailbox = await createMailbox();

    await expect(mailbox.enqueue('too early')).resolves.toMatchObject({
      accepted: false,
      reason: 'no_active_turn',
    });

    const turn = mailbox.beginTurn();
    await expect(mailbox.enqueue('first')).resolves.toMatchObject({
      accepted: true,
      turnId: turn.id,
      queued: 1,
      delivery: 'current_turn',
    });
    await expect(mailbox.enqueue('second')).resolves.toMatchObject({
      accepted: true,
      queued: 2,
    });

    const claimed = await mailbox.drain(turn);
    expect(claimed.map((message) => message.content)).toEqual(['first', 'second']);
    expect(mailbox.pendingCount()).toBe(2);
    await expect(mailbox.drain(turn)).resolves.toEqual([]);
    await mailbox.acknowledge(claimed.map((message) => message.id));
    expect(mailbox.pendingCount()).toBe(0);
    await mailbox.finishTurn(turn);
  });

  it('stages startup input and defers input after atomic sealing', async () => {
    const mailbox = await createMailbox();
    await expect(
      mailbox.enqueue('startup guidance', { allowBeforeTurn: true })
    ).resolves.toMatchObject({
      accepted: true,
      queued: 1,
      delivery: 'next_turn',
    });

    const turn = mailbox.beginTurn();
    const claimed = await mailbox.drain(turn);
    expect(claimed[0]?.content).toBe('startup guidance');
    await mailbox.acknowledge(claimed.map((message) => message.id));
    await expect(mailbox.drainOrSeal(turn)).resolves.toEqual({
      messages: [],
      sealed: true,
    });
    await expect(mailbox.enqueue('too late')).resolves.toMatchObject({
      accepted: true,
      delivery: 'next_turn',
    });
    expect(() => mailbox.beginTurn()).toThrow('already has an active turn');

    const nextTurn = await mailbox.finishTurn(turn, { continuePending: true });
    expect(nextTurn?.id).toBeTruthy();
    await expect(mailbox.drain(nextTurn!)).resolves.toEqual([
      expect.objectContaining({ content: 'too late' }),
    ]);
    await mailbox.finishTurn(nextTurn!);
  });

  it('atomically prepares and claims a durable direct input turn', async () => {
    const mailbox = await createMailbox('direct-input-session');

    const prepared = await mailbox.prepareInputTurn('durable first prompt');
    expect(prepared).toMatchObject({
      accepted: true,
      queued: 1,
      mode: 'direct',
    });
    if (!prepared.accepted) throw new Error('Expected input preparation to succeed');

    await expect(mailbox.claimedMessageIds(prepared.handle)).resolves.toEqual([
      prepared.messageId,
    ]);
    await expect(mailbox.drain(prepared.handle)).resolves.toEqual([]);
    expect(mailbox.pendingMessages()).toEqual([
      expect.objectContaining({
        id: prepared.messageId,
        content: 'durable first prompt',
      }),
    ]);
    await mailbox.finishTurn(prepared.handle);
  });

  it('keeps older durable input ahead of a newly prepared prompt', async () => {
    const mailbox = await createMailbox('ordered-input-session');
    await mailbox.enqueue('older pending prompt', { allowBeforeTurn: true });

    const prepared = await mailbox.prepareInputTurn('new prompt');
    expect(prepared).toMatchObject({
      accepted: true,
      queued: 2,
      mode: 'pending',
    });
    if (!prepared.accepted) throw new Error('Expected input preparation to succeed');

    await expect(mailbox.claimedMessageIds(prepared.handle)).resolves.toEqual([]);
    const pending = await mailbox.drain(prepared.handle);
    expect(pending.map((message) => message.content)).toEqual([
      'older pending prompt',
      'new prompt',
    ]);
    await mailbox.finishTurn(prepared.handle);
  });

  it('allows only one concurrent input preparation to own the turn', async () => {
    const mailbox = await createMailbox('concurrent-input-session');

    const [first, second] = await Promise.all([
      mailbox.prepareInputTurn('first'),
      mailbox.prepareInputTurn('second'),
    ]);
    const accepted = [first, second].filter((result) => result.accepted);
    const rejected = [first, second].filter((result) => !result.accepted);

    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([
      expect.objectContaining({ accepted: false, reason: 'turn_active' }),
    ]);
    expect(mailbox.pendingCount()).toBe(1);
  });

  it('fails closed when the pending steering budget is exhausted', async () => {
    const mailbox = await createMailbox();
    const turn = mailbox.beginTurn();

    for (let index = 0; index < 20; index++) {
      expect((await mailbox.enqueue(`message-${index}`)).accepted).toBe(true);
    }
    await expect(mailbox.enqueue('overflow')).resolves.toMatchObject({
      accepted: false,
      turnId: turn.id,
      reason: 'queue_full',
      queued: 20,
    });
  });

  it('enforces the pending limit under concurrent enqueue calls', async () => {
    const mailbox = await createMailbox('concurrent-session');
    mailbox.beginTurn();

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => mailbox.enqueue(`concurrent-${index}`))
    );

    expect(results.filter((result) => result.accepted)).toHaveLength(20);
    expect(results.filter((result) => !result.accepted)).toHaveLength(5);
    expect(mailbox.pendingCount()).toBe(20);
  });

  it('recovers accepted but unacknowledged guidance after restart', async () => {
    const first = await createMailbox('recovered-session');
    const firstTurn = first.beginTurn();
    await first.enqueue('retry this guidance');
    await first.finishTurn(firstTurn);

    const recovered = await createMailbox('recovered-session');
    expect(recovered.recoveredCount()).toBe(1);
    const retryTurn = await recovered.beginPendingTurn();
    await expect(recovered.drain(retryTurn!)).resolves.toEqual([
      expect.objectContaining({
        content: 'retry this guidance',
        recovered: true,
      }),
    ]);
  });

  it('recovers a prepared direct input when the process exits before completion', async () => {
    const first = await createMailbox('recovered-direct-input');
    const prepared = await first.prepareInputTurn('recover this initial prompt');
    if (!prepared.accepted) throw new Error('Expected input preparation to succeed');
    await first.finishTurn(prepared.handle);

    const recovered = await createMailbox('recovered-direct-input');
    expect(recovered.recoveredCount()).toBe(1);
    const retryTurn = await recovered.beginPendingTurn();
    await expect(recovered.drain(retryTurn!)).resolves.toEqual([
      expect.objectContaining({
        id: prepared.messageId,
        content: 'recover this initial prompt',
        recovered: true,
      }),
    ]);
  });

  it('persists accepted guidance with owner-only permissions', async () => {
    const mailbox = await createMailbox('permission-session');
    await mailbox.enqueue('private guidance', { allowBeforeTurn: true });

    const file = await stat(
      getSessionInboxFilePath(workspaceRoot, 'permission-session')
    );
    expect(file.mode & 0o777).toBe(0o600);
  });

  it('fails closed for a corrupted durable inbox', async () => {
    const inboxPath = getSessionInboxFilePath(workspaceRoot, 'corrupted-session');
    await mkdir(path.dirname(inboxPath), { recursive: true });
    await writeFile(inboxPath, '{"version":1,"messages":', 'utf8');

    await expect(
      ActiveTurnMailbox.create(workspaceRoot, 'corrupted-session')
    ).rejects.toThrow('Invalid steering inbox JSON');
  });

  it('retries transcript-committed guidance until a completion ack exists', async () => {
    const first = await createMailbox('reconciled-session');
    const firstTurn = first.beginTurn();
    await first.enqueue('committed guidance');
    const [claimed] = await first.drain(firstTurn);
    expect(claimed).toBeDefined();

    const persistentStore = new PersistentStore(workspaceRoot);
    await persistentStore.initialize();
    await persistentStore.saveMessage(
      'reconciled-session',
      'user',
      claimed!.content,
      null,
      { inboxMessageId: claimed!.id }
    );

    const crashRecovered = await createMailbox('reconciled-session');
    expect(crashRecovered.pendingCount()).toBe(1);
    expect(crashRecovered.recoveredCount()).toBe(1);

    await persistentStore.acknowledgeInboxMessages('reconciled-session', [claimed!.id]);
    const reconciled = await createMailbox('reconciled-session');
    expect(reconciled.pendingCount()).toBe(0);
    expect(reconciled.recoveredCount()).toBe(0);
  });
});
