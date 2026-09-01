import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  ActiveTurnMailbox,
  MAX_PENDING_BACKGROUND_COMPLETIONS,
  MAX_PENDING_STEER_CHARS,
  MAX_PENDING_STEERS,
} from '../../../../src/agent/runtime/ActiveTurnMailbox.js';
import { DurableSteeringInbox } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import type { BackgroundSubagentCompletion } from '../../../../src/agent/subagents/BackgroundSubagentCompletion.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../../src/context/storage/pathUtils.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';
import { MAX_TURN_INPUT_MESSAGE_IDS } from '../../../../src/context/types.js';

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

  it('keeps the durable turn identity limit aligned with mailbox capacities', () => {
    expect(MAX_PENDING_STEERS + MAX_PENDING_BACKGROUND_COMPLETIONS).toBe(
      MAX_TURN_INPUT_MESSAGE_IDS
    );
  });

  it('stores remote inboxes directly under an explicitly authorized state root', async () => {
    const sessionId = 'remote-inbox';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const mailbox = await ActiveTurnMailbox.create(
      hostStateRoot,
      sessionId,
      remoteStorage
    );
    await mailbox.enqueue('remote guidance', { allowBeforeTurn: true });

    const inboxPath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => path.join(String(scope), `${sessionId}.inbox.json`)
    );
    expect(JSON.parse(await readFile(inboxPath, 'utf8'))).toMatchObject({
      sessionId,
      messages: [expect.objectContaining({ content: 'remote guidance' })],
    });
    await expect(
      ActiveTurnMailbox.create(hostStateRoot, sessionId, remoteStorage)
    ).resolves.toMatchObject({});
    await expect(
      stat(getSessionInboxFilePath(hostStateRoot, sessionId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates the remote state scope before inbox reads and writes', async () => {
    if (process.platform === 'win32') return;

    const sessionId = 'remote-inbox-gate';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const inbox = await DurableSteeringInbox.open(
      hostStateRoot,
      sessionId,
      remoteStorage
    );
    await inbox.enqueue({
      id: 'remote-message',
      content: 'guard this write',
      queuedAt: Date.now(),
    });

    await chmod(hostStateRoot, 0o755);
    await expect(inbox.acknowledge(['remote-message'])).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    await expect(
      DurableSteeringInbox.open(hostStateRoot, sessionId, remoteStorage)
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    await chmod(hostStateRoot, 0o700);
  });

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

  it('rejects one multimodal message above the durable content budget', async () => {
    const mailbox = await createMailbox('oversized-multimodal-session');
    mailbox.beginTurn();

    await expect(
      mailbox.enqueue([
        {
          type: 'image_url',
          image_url: { url: 'x'.repeat(MAX_PENDING_STEER_CHARS + 1) },
        },
      ])
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'queue_full',
      queued: 0,
    });
    expect(mailbox.pendingCount()).toBe(0);
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

  it('keeps durable background completions idempotent and separate from user capacity', async () => {
    const mailbox = await createMailbox('background-completion-capacity');
    const completion = (index: number): BackgroundSubagentCompletion => ({
      inboxMessageId: `background-subagent-completion:agent-${index}`,
      childSessionId: `agent-${index}`,
      content: `background-result-${index}`,
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId: `agent-${index}`,
        },
      },
      subagentRef: {
        subagentSessionId: `agent-${index}`,
        subagentType: 'Explore',
        subagentStatus: 'completed',
      },
    });

    for (let index = 0; index < MAX_PENDING_BACKGROUND_COMPLETIONS; index++) {
      await expect(
        mailbox.enqueueBackgroundSubagentCompletion(completion(index))
      ).resolves.toMatchObject({
        accepted: true,
        delivery: 'next_turn',
      });
    }
    await expect(
      mailbox.enqueueBackgroundSubagentCompletion(completion(0))
    ).resolves.toMatchObject({
      accepted: true,
      queued: MAX_PENDING_BACKGROUND_COMPLETIONS,
      duplicate: true,
    });
    await expect(
      mailbox.enqueueBackgroundSubagentCompletion(
        completion(MAX_PENDING_BACKGROUND_COMPLETIONS)
      )
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'queue_full',
      queued: MAX_PENDING_BACKGROUND_COMPLETIONS,
    });

    const turn = mailbox.beginTurn();
    for (let index = 0; index < 20; index++) {
      expect((await mailbox.enqueue(`user-${index}`)).accepted).toBe(true);
    }
    await expect(mailbox.enqueue('user-overflow')).resolves.toMatchObject({
      accepted: false,
      reason: 'queue_full',
      queued: MAX_PENDING_BACKGROUND_COMPLETIONS + 20,
    });
    await mailbox.finishTurn(turn);

    const recovered = await createMailbox('background-completion-capacity');
    expect(recovered.pendingMessages()[0]).toMatchObject({
      id: 'background-subagent-completion:agent-0',
      origin: 'background_subagent',
      persisted: true,
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId: 'agent-0',
        },
      },
    });
  });

  it('keeps durable teammate messages idempotent across mailbox recovery', async () => {
    const first = await createMailbox('team-message-session');
    await expect(
      first.enqueue('untrusted teammate payload', {
        allowBeforeTurn: true,
        messageId: 'team-message-1',
        origin: 'team_message',
        metadata: {
          clientVisible: false,
          teamMessage: {
            messageId: 'team-message-1',
            teamName: 'review-team',
            from: 'reviewer',
            to: 'team-lead',
          },
        },
      })
    ).resolves.toMatchObject({
      accepted: true,
      delivery: 'next_turn',
    });

    const recovered = await createMailbox('team-message-session');
    await expect(
      recovered.enqueue('untrusted teammate payload', {
        allowBeforeTurn: true,
        messageId: 'team-message-1',
        origin: 'team_message',
        metadata: {
          clientVisible: false,
          teamMessage: {
            messageId: 'team-message-1',
            teamName: 'review-team',
            from: 'reviewer',
            to: 'team-lead',
          },
        },
      })
    ).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      queued: 1,
    });
    expect(recovered.pendingMessages()).toEqual([
      expect.objectContaining({
        id: 'team-message-1',
        origin: 'team_message',
        recovered: true,
        metadata: expect.objectContaining({ clientVisible: false }),
      }),
    ]);
  });

  it('rejects a hard-limit overflow without throwing or mutating the inbox', async () => {
    const inbox = await DurableSteeringInbox.open(workspaceRoot, 'hard-limit-capacity');
    await expect(
      inbox.enqueue({
        id: 'large-existing-message',
        content: 'x'.repeat(7 * 1024 * 1024),
        queuedAt: 1,
      })
    ).resolves.toBe(true);

    await expect(
      inbox.enqueue({
        id: 'overflow-message',
        content: 'y'.repeat(2 * 1024 * 1024),
        queuedAt: 2,
      })
    ).resolves.toBe(false);
    expect(inbox.list()).toEqual([
      expect.objectContaining({ id: 'large-existing-message' }),
    ]);
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

  it('reconciles embedded abort acknowledgements when the compat tail is truncated', async () => {
    const sessionId = 'embedded-abort-ack';
    const first = await createMailbox(sessionId);
    const prepared = await first.prepareInputTurn('do not replay this input');
    if (!prepared.accepted) throw new Error('Expected input preparation to succeed');
    const store = new PersistentStore(workspaceRoot);
    await store.saveTurnStart(sessionId, {
      turnId: prepared.handle.id,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: [prepared.messageId],
    });
    await store.saveMessage(sessionId, 'user', 'do not replay this input', null, {
      inboxMessageId: prepared.messageId,
    });
    await store.saveTurnAbort(
      sessionId,
      {
        turnId: prepared.handle.id,
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
      { acknowledgeInputMessageIds: [prepared.messageId] }
    );
    const transcriptPath = getSessionFilePath(workspaceRoot, sessionId);
    const lines = (await readFile(transcriptPath, 'utf8')).trimEnd().split('\n');
    const terminal = JSON.parse(lines.at(-2) ?? '{}') as {
      type?: string;
      data?: { acknowledgedInputMessageIds?: string[] };
    };
    const compatibilityAcknowledgement = JSON.parse(lines.at(-1) ?? '{}') as {
      type?: string;
    };
    expect(terminal).toMatchObject({
      type: 'turn_aborted',
      data: { acknowledgedInputMessageIds: [prepared.messageId] },
    });
    expect(compatibilityAcknowledgement.type).toBe('inbox_acknowledged');
    await writeFile(transcriptPath, `${lines.slice(0, -1).join('\n')}\n{`, 'utf8');

    const recovered = await createMailbox(sessionId);
    expect(recovered.pendingMessages()).toEqual([]);
  });

  it('keeps pending input when an isolated abort claims its acknowledgement', async () => {
    const sessionId = 'isolated-embedded-abort-ack';
    const messageId = 'pending-isolated-abort-input';
    const inbox = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    await inbox.enqueue({
      id: messageId,
      content: 'must still run',
      queuedAt: Date.now(),
    });
    const timestamp = new Date().toISOString();
    await writeFile(
      getSessionFilePath(workspaceRoot, sessionId),
      `${JSON.stringify({
        id: 'isolated-abort',
        sessionId,
        projectPath: workspaceRoot,
        timestamp,
        type: 'turn_aborted',
        cwd: workspaceRoot,
        version: 'test',
        data: {
          turnId: 'turn-without-start',
          cause: 'process_restart',
          abortedAt: timestamp,
          turnsCount: 0,
          toolCallsCount: 0,
          durationMs: 0,
          recovery: {
            version: 1,
            inputMessageIds: [messageId],
            hadSuccessfulToolResult: false,
            emptyFinalCorrectionSpent: false,
          },
          acknowledgedInputMessageIds: [messageId],
        },
      })}\n`,
      'utf8'
    );

    const reopened = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ id: messageId, recovered: true }),
    ]);
  });

  it('persists a validated turn-scoped output schema with direct input', async () => {
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    const first = await createMailbox('schema-direct-input');
    const prepared = await first.prepareInputTurn('return an answer', {
      outputSchema,
    });
    if (!prepared.accepted) throw new Error('Expected input preparation to succeed');
    await first.finishTurn(prepared.handle);

    const recovered = await createMailbox('schema-direct-input');
    const retryTurn = await recovered.beginPendingTurn();
    await expect(recovered.drain(retryTurn!)).resolves.toEqual([
      expect.objectContaining({
        content: 'return an answer',
        outputSchema,
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
