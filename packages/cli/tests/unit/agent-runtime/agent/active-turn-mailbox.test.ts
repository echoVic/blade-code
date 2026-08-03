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
    });
    await expect(mailbox.enqueue('second')).resolves.toMatchObject({
      accepted: true,
      queued: 2,
    });

    const claimed = mailbox.drain(turn);
    expect(claimed.map((message) => message.content)).toEqual(['first', 'second']);
    expect(mailbox.pendingCount()).toBe(2);
    expect(mailbox.drain(turn)).toEqual([]);
    await mailbox.acknowledge(claimed.map((message) => message.id));
    expect(mailbox.pendingCount()).toBe(0);
    mailbox.endTurn(turn);
  });

  it('stages input during turn startup and rejects input after atomic sealing', async () => {
    const mailbox = await createMailbox();
    await expect(
      mailbox.enqueue('startup guidance', { allowBeforeTurn: true })
    ).resolves.toMatchObject({
      accepted: true,
      queued: 1,
    });

    const turn = mailbox.beginTurn();
    const claimed = mailbox.drain(turn);
    expect(claimed[0]?.content).toBe('startup guidance');
    await mailbox.acknowledge(claimed.map((message) => message.id));
    expect(mailbox.drainOrSeal(turn)).toEqual({ messages: [], sealed: true });
    await expect(mailbox.enqueue('too late')).resolves.toMatchObject({
      accepted: false,
      reason: 'turn_sealed',
    });
    expect(() => mailbox.beginTurn()).toThrow('already has an active turn');

    mailbox.endTurn(turn);
    expect(mailbox.beginTurn().id).toBeTruthy();
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
    first.endTurn(firstTurn);

    const recovered = await createMailbox('recovered-session');
    expect(recovered.recoveredCount()).toBe(1);
    const retryTurn = recovered.beginTurn();
    expect(recovered.drain(retryTurn)).toEqual([
      expect.objectContaining({
        content: 'retry this guidance',
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

  it('reconciles transcript-committed guidance when ack did not finish', async () => {
    const first = await createMailbox('reconciled-session');
    const firstTurn = first.beginTurn();
    await first.enqueue('committed guidance');
    const [claimed] = first.drain(firstTurn);
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

    const reconciled = await createMailbox('reconciled-session');
    expect(reconciled.pendingCount()).toBe(0);
    expect(reconciled.recoveredCount()).toBe(0);
  });
});
