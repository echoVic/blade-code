import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentSession,
  type AgentSessionOwner,
  AgentSessionStore,
  isAgentSessionOwnedBy,
} from '../../../../src/agent/subagents/AgentSessionStore.js';

describe('AgentSessionStore', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;
  let store: AgentSessionStore;

  const makeSession = (
    id: string,
    overrides: Partial<AgentSession> = {}
  ): AgentSession => ({
    schemaVersion: 2,
    id,
    subagentType: 'Explore',
    description: 'Inspect the implementation',
    prompt: 'Inspect the implementation and report findings.',
    messages: [],
    status: 'running',
    createdAt: 1_000,
    lastActiveAt: 1_000,
    parentSessionId: 'parent-session',
    parentProjectPath: '/workspace/a',
    rootAgentId: id,
    resumeDepth: 0,
    workspaceRoot: '/workspace/a',
    ...overrides,
  });

  beforeEach(() => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-agent-store-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    (AgentSessionStore as unknown as { instance: AgentSessionStore | null }).instance =
      null;
    store = AgentSessionStore.getInstance();
  });

  afterEach(async () => {
    (AgentSessionStore as unknown as { instance: AgentSessionStore | null }).instance =
      null;
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('creates one singleton and a private session directory', () => {
    expect(AgentSessionStore.getInstance()).toBe(store);
    const directory = path.join(storageRoot, 'agents', 'sessions');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('scopes the singleton and cache to the current storage root', async () => {
    store.saveSession(makeSession('agent-first-root'));
    const secondRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-agent-store-'));

    try {
      process.env.BLADE_STORAGE_ROOT = secondRoot;
      const secondStore = AgentSessionStore.getInstance();

      expect(secondStore).not.toBe(store);
      expect(secondStore.loadSession('agent-first-root')).toBeUndefined();
      secondStore.saveSession(makeSession('agent-second-root'));
      expect(
        readFileSync(
          path.join(secondRoot, 'agents', 'sessions', 'agent-second-root.json'),
          'utf8'
        )
      ).toContain('"id": "agent-second-root"');
    } finally {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('atomically persists schema v2 sidecars with private permissions', () => {
    const session = makeSession('agent-save');
    store.saveSession(session);

    const filePath = path.join(storageRoot, 'agents', 'sessions', 'agent-save.json');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, 'utf8').endsWith('\n')).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      id: 'agent-save',
      rootAgentId: 'agent-save',
      resumeDepth: 0,
    });
    expect(store.loadSession('agent-save')).toEqual(session);
  });

  it('recreates the private session directory before each write', async () => {
    await rm(path.join(storageRoot, 'agents'), {
      recursive: true,
      force: true,
    });

    store.saveSession(makeSession('agent-recovered-directory'));

    const directory = path.join(storageRoot, 'agents', 'sessions');
    const filePath = path.join(directory, 'agent-recovered-directory.json');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('rejects unsafe IDs before filesystem access', () => {
    expect(() => store.saveSession(makeSession('../escape'))).toThrow(
      'Invalid session ID'
    );
    expect(store.loadSession('../escape')).toBeUndefined();
    expect(store.deleteSession('../escape')).toBe(false);
  });

  it('fails closed for corrupt or mismatched sidecars', () => {
    const directory = path.join(storageRoot, 'agents', 'sessions');
    writeFileSync(path.join(directory, 'agent-corrupt.json'), '{bad json\n');
    writeFileSync(
      path.join(directory, 'agent-mismatch.json'),
      JSON.stringify(makeSession('different-id'))
    );

    expect(store.loadSession('agent-corrupt')).toBeUndefined();
    expect(store.loadSession('agent-mismatch')).toBeUndefined();
  });

  it('normalizes a legacy sidecar only when it has an absolute owner workspace', () => {
    const directory = path.join(storageRoot, 'agents', 'sessions');
    writeFileSync(
      path.join(directory, 'agent-legacy.json'),
      JSON.stringify({
        id: 'agent-legacy',
        subagentType: 'Explore',
        description: 'Legacy task',
        prompt: 'Continue legacy work',
        messages: [],
        status: 'completed',
        createdAt: 1,
        lastActiveAt: 2,
        parentSessionId: 'parent-session',
        workspaceRoot: '/workspace/a',
      })
    );

    expect(store.loadSession('agent-legacy')).toMatchObject({
      schemaVersion: 2,
      id: 'agent-legacy',
      rootAgentId: 'agent-legacy',
      resumeDepth: 0,
      parentProjectPath: '/workspace/a',
    });
  });

  it('requires the complete parent session and workspace owner', () => {
    const session = makeSession('agent-owner');
    const owner: AgentSessionOwner = {
      sessionId: 'parent-session',
      projectPath: '/workspace/a',
    };
    expect(isAgentSessionOwnedBy(session, owner)).toBe(true);
    expect(
      isAgentSessionOwnedBy(session, {
        sessionId: 'parent-session',
        projectPath: '/workspace/b',
      })
    ).toBe(false);
    expect(
      isAgentSessionOwnedBy(session, {
        sessionId: 'other-parent',
        projectPath: '/workspace/a',
      })
    ).toBe(false);
  });

  it('updates messages and marks terminal results durably', () => {
    store.saveSession(makeSession('agent-update'));
    store.updateSession('agent-update', {
      messages: [{ role: 'assistant', content: 'prior result' }],
    });
    const completed = store.markCompleted(
      'agent-update',
      {
        success: true,
        message: 'Done',
        verificationCommands: ['bun test'],
      },
      { duration: 123, toolCalls: 2 }
    );

    expect(completed).toMatchObject({
      status: 'completed',
      messages: [{ role: 'assistant', content: 'prior result' }],
      result: {
        success: true,
        message: 'Done',
        verificationCommands: ['bun test'],
      },
      stats: { duration: 123, toolCalls: 2 },
    });
    store.clearCache();
    expect(store.loadSession('agent-update')).toMatchObject({
      status: 'completed',
      result: { message: 'Done' },
    });
  });

  it('lists newest sessions first and cleans only expired terminal runs', () => {
    store.saveSession(
      makeSession('agent-old', {
        status: 'completed',
        lastActiveAt: 0,
      })
    );
    store.saveSession(
      makeSession('agent-new', {
        status: 'completed',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
    );
    store.saveSession(
      makeSession('agent-running', {
        status: 'running',
        lastActiveAt: 0,
      })
    );

    expect(store.listSessions().map((session) => session.id)).toEqual([
      'agent-new',
      'agent-old',
      'agent-running',
    ]);
    expect(store.cleanupExpiredSessions(1_000)).toBe(1);
    expect(store.loadSession('agent-old')).toBeUndefined();
    expect(store.loadSession('agent-running')).toBeDefined();
  });

  it('keeps immutable resume lineage in independent sidecars', () => {
    const root = makeSession('agent-root', {
      status: 'completed',
      result: { success: true, message: 'Root result' },
    });
    const resumed = makeSession('agent-resumed', {
      rootAgentId: root.id,
      resumedFrom: root.id,
      resumeDepth: 1,
      messages: [{ role: 'assistant', content: 'Root result' }],
    });
    store.saveSession(root);
    store.saveSession(resumed);

    expect(store.loadSession(root.id)).toEqual(root);
    expect(store.loadSession(resumed.id)).toMatchObject({
      rootAgentId: root.id,
      resumedFrom: root.id,
      resumeDepth: 1,
    });
  });
});
