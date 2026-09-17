import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import writeFileAtomic from 'write-file-atomic';

vi.unmock('node:child_process');

import type {
  SessionLocatorV2,
  SessionSurfaceSummary,
} from '../../../../../src/api/sessionSurfaceSchemas.js';
import { TuiTaskAttentionStore } from '../../../../../src/ui/services/TuiTaskAttentionStore.js';

const COMPLETED_AT = '2026-09-04T12:30:00.000Z';
const LATER_COMPLETED_AT = '2026-09-04T12:31:00.000Z';
const REMOTE_REF = `acp-remote-workspace:${'a'.repeat(43)}`;
const WRITER_FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/tui-task-attention-writer.ts', import.meta.url)
);
const temporaryRoots: string[] = [];
const activeChildren = new Set<ChildProcess>();

interface StoredAttentionEntry {
  key: string;
  signature: string | null;
  unread: boolean;
}

interface StoredAttentionFile {
  version: 1;
  entries: StoredAttentionEntry[];
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-attention-'));
  temporaryRoots.push(root);
  return root;
}

function filePath(root: string): string {
  return path.join(root, 'tui-task-attention-v1.json');
}

function createLocalSummary(
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId: 'session-1',
      workspace: { kind: 'local', projectPath: '/workspace/private-a' },
    },
    displayCwd: '/workspace/private-a',
    title: 'private task title',
    rootId: 'session-1',
    taskStatus: 'running',
    messageCount: 1,
    firstMessageTime: '2026-09-04T12:00:00.000Z',
    lastMessageTime: '2026-09-04T12:01:00.000Z',
    hasErrors: false,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: true },
      turn: { start: true },
      files: { readText: true, writeText: true, browse: 'tree' },
      terminal: { mode: 'interactive', owner: 'local' },
    },
    ...overrides,
  };
}

function createRemoteSummary(
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    ...createLocalSummary(),
    locator: {
      version: 2,
      sessionId: 'session-1',
      workspace: { kind: 'acp-remote', workspaceRef: REMOTE_REF },
    },
    displayCwd: '/remote/private-workspace',
    capabilities: {
      connection: 'online',
      history: { read: true, fork: true },
      turn: { start: true },
      files: { readText: true, writeText: true, browse: 'tree' },
      terminal: { mode: 'interactive', owner: 'acp-remote' },
    },
    ...overrides,
  };
}

function terminal(
  summary: SessionSurfaceSummary,
  taskStatus: 'completed' | 'failed' | 'interrupted' = 'completed',
  taskCompletedAt = COMPLETED_AT
): SessionSurfaceSummary {
  return { ...summary, taskStatus, taskCompletedAt };
}

function digestLocator(locator: SessionLocatorV2): string {
  const canonical =
    locator.workspace.kind === 'local'
      ? [2, 'local', locator.workspace.projectPath, locator.sessionId]
      : [2, 'acp-remote', locator.workspace.workspaceRef, locator.sessionId];
  return createHash('sha256')
    .update('blade-tui-task-attention-locator-v1\0')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readStoredFile(target: string): Promise<StoredAttentionFile> {
  const value: unknown = JSON.parse(await readFile(target, 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('invalid attention fixture');
  }
  const entries: StoredAttentionEntry[] = value.entries.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.key !== 'string' ||
      (candidate.signature !== null && typeof candidate.signature !== 'string') ||
      typeof candidate.unread !== 'boolean'
    ) {
      throw new Error('invalid attention entry fixture');
    }
    return {
      key: candidate.key,
      signature: candidate.signature,
      unread: candidate.unread,
    };
  });
  return { version: 1, entries };
}

async function runWriter(root: string, session: 'a' | 'b'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', [WRITER_FIXTURE, root, session], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    let stderr = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('writer fixture exceeded deadline'));
    }, 5_000);
    deadline.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      activeChildren.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      activeChildren.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`writer exited code=${code} signal=${signal}: ${stderr}`));
    });
  });
}

async function waitForFile(target: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await stat(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error('writer fixture did not become ready');
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const children = [...activeChildren];
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('exit', () => resolve());
        })
    )
  );
  activeChildren.clear();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('TuiTaskAttentionStore', () => {
  it('silently baselines first-seen running and historical terminal sessions', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const running = createLocalSummary();
    const historical = terminal(createRemoteSummary());

    await expect(store.reconcile([running, historical])).resolves.toEqual({
      unreadKeys: [],
    });

    const persisted = await readFile(filePath(root), 'utf8');
    const state = await readStoredFile(filePath(root));
    expect(state.version).toBe(1);
    expect(state.entries).toHaveLength(2);
    expect(state.entries.map((entry) => entry.key)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(state.entries.map((entry) => entry.signature)).toEqual([
      JSON.stringify(['completed', COMPLETED_AT]),
      null,
    ]);
    expect(persisted).not.toContain('/workspace/private-a');
    expect(persisted).not.toContain('/remote/private-workspace');
    expect(persisted).not.toContain(REMOTE_REF);
    expect(persisted).not.toContain('private task title');
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'marks a known non-terminal session unread when it becomes %s',
    async (taskStatus) => {
      const root = await temporaryRoot();
      const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
      const running = createLocalSummary();
      await store.reconcile([running]);

      const snapshot = await store.reconcile([terminal(running, taskStatus)]);

      expect(snapshot.unreadKeys).toHaveLength(1);
      expect(store.snapshot()).toEqual(snapshot);
      expect((await readStoredFile(filePath(root))).entries[0]).toMatchObject({
        signature: null,
        unread: true,
      });
    }
  );

  it('treats cancelled and other non-terminal states as null without creating unread', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const running = createLocalSummary();
    await store.reconcile([running]);

    expect(
      (await store.reconcile([{ ...running, taskStatus: 'cancelled' }])).unreadKeys
    ).toEqual([]);
    expect((await readStoredFile(filePath(root))).entries[0]).toMatchObject({
      signature: null,
      unread: false,
    });
  });

  it('preserves read state for the same terminal signature', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const completed = terminal(createLocalSummary());
    await store.reconcile([completed]);

    expect((await store.reconcile([completed])).unreadKeys).toEqual([]);
    expect((await readStoredFile(filePath(root))).entries[0]).toMatchObject({
      signature: JSON.stringify(['completed', COMPLETED_AT]),
      unread: false,
    });
  });

  it('retains an existing unread marker while a session becomes non-terminal', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const running = createLocalSummary();
    await store.reconcile([running]);
    await store.reconcile([terminal(running)]);

    const snapshot = await store.reconcile([running]);

    expect(snapshot.unreadKeys).toHaveLength(1);
    expect((await readStoredFile(filePath(root))).entries[0]).toMatchObject({
      signature: null,
      unread: true,
    });
  });

  it('keeps a changed terminal signature unread until exact acknowledgement', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const first = terminal(createLocalSummary());
    const second = terminal(first, 'failed', LATER_COMPLETED_AT);
    await store.reconcile([first]);

    expect((await store.reconcile([second])).unreadKeys).toHaveLength(1);
    expect((await readStoredFile(filePath(root))).entries[0]?.signature).toBe(
      JSON.stringify(['completed', COMPLETED_AT])
    );

    expect((await store.acknowledge(second)).unreadKeys).toEqual([]);
    expect((await readStoredFile(filePath(root))).entries[0]).toMatchObject({
      signature: JSON.stringify(['failed', LATER_COMPLETED_AT]),
      unread: false,
    });
    expect((await store.reconcile([second])).unreadKeys).toEqual([]);
  });

  it('isolates duplicate session IDs across local and remote workspaces', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const local = createLocalSummary();
    const remote = createRemoteSummary();
    await store.reconcile([local, remote]);

    const snapshot = await store.reconcile([terminal(local), remote]);
    const state = await readStoredFile(filePath(root));

    expect(snapshot.unreadKeys).toHaveLength(1);
    expect(new Set(state.entries.map((entry) => entry.key)).size).toBe(2);
    expect(state.entries.filter((entry) => entry.unread)).toHaveLength(1);
  });

  it('acknowledges only the exact visible locator during reconciliation', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const local = createLocalSummary();
    const remote = createRemoteSummary();
    await store.reconcile([local, remote]);
    await store.reconcile([terminal(local), terminal(remote)]);

    const snapshot = await store.reconcile(
      [terminal(local), terminal(remote)],
      remote.locator
    );

    expect(snapshot.unreadKeys).toHaveLength(1);
    const entries = (await readStoredFile(filePath(root))).entries;
    expect(entries.filter((entry) => entry.unread)).toHaveLength(1);
    expect(entries.find((entry) => !entry.unread)?.signature).toBe(
      JSON.stringify(['completed', COMPLETED_AT])
    );
    expect(entries.at(-1)?.key).toBe(digestLocator(remote.locator));
  });

  it('prunes entries absent from a complete catalog', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    await store.reconcile([createLocalSummary(), createRemoteSummary()]);

    await store.reconcile([createRemoteSummary()]);

    expect((await readStoredFile(filePath(root))).entries).toHaveLength(1);
  });

  it('rejects unknown, malformed, non-canonical, and duplicate payloads fail-soft', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const seed = new TuiTaskAttentionStore({ filePath: target });
    const running = createLocalSummary();
    await seed.reconcile([running]);
    const validEntry = (await readStoredFile(target)).entries[0];
    expect(validEntry).toBeDefined();

    const invalidPayloads: unknown[] = [
      { version: 2, entries: [] },
      { version: 1, entries: 'not-an-array' },
      { version: 1, entries: [{ ...validEntry, extra: true }] },
      { version: 1, entries: [{ ...validEntry, key: 'not-a-digest' }] },
      {
        version: 1,
        entries: [{ ...validEntry, signature: '["completed","not-canonical"]' }],
      },
      { version: 1, entries: [validEntry, validEntry] },
    ];

    for (const payload of invalidPayloads) {
      await writeFile(target, JSON.stringify(payload));
      const store = new TuiTaskAttentionStore({ filePath: target });
      expect((await store.reconcile([terminal(running)])).unreadKeys).toEqual([]);
    }
  });

  it('rejects oversized entry arrays before accepting any ledger state', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const seed = new TuiTaskAttentionStore({ filePath: target });
    const running = createLocalSummary();
    await seed.reconcile([running]);
    const validEntry = (await readStoredFile(target)).entries[0];
    expect(validEntry).toBeDefined();
    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: 20_001 }, (_, index) => ({
          ...validEntry,
          key: index.toString(16).padStart(64, '0'),
        })),
      })
    );

    const store = new TuiTaskAttentionStore({ filePath: target });

    expect((await store.reconcile([terminal(running)])).unreadKeys).toEqual([]);
  });

  it('rejects oversized files without using partial state', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    await writeFile(target, ' '.repeat(4 * 1024 * 1024 + 1));

    const store = new TuiTaskAttentionStore({ filePath: target });

    await expect(store.reconcile([terminal(createLocalSummary())])).resolves.toEqual({
      unreadKeys: [],
    });
  });

  it('retains all null and unread entries plus the 1024 newest acknowledged terminals', async () => {
    const root = await temporaryRoot();
    const store = new TuiTaskAttentionStore({ filePath: filePath(root) });
    const becomesUnread = createLocalSummary({
      locator: {
        version: 2,
        sessionId: 'unread',
        workspace: { kind: 'local', projectPath: '/workspace/unread' },
      },
      rootId: 'unread',
    });
    const remainsRunning = createLocalSummary({
      locator: {
        version: 2,
        sessionId: 'running',
        workspace: { kind: 'local', projectPath: '/workspace/running' },
      },
      rootId: 'running',
    });
    const acknowledged = Array.from({ length: 1_026 }, (_, index) =>
      terminal(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: `terminal-${index}`,
            workspace: {
              kind: 'local',
              projectPath: `/workspace/terminal-${index}`,
            },
          },
          rootId: `terminal-${index}`,
        })
      )
    );
    await store.reconcile([becomesUnread, remainsRunning, ...acknowledged]);

    const snapshot = await store.reconcile([
      terminal(becomesUnread),
      remainsRunning,
      ...acknowledged,
    ]);
    const entries = (await readStoredFile(filePath(root))).entries;

    expect(snapshot.unreadKeys).toHaveLength(1);
    expect(entries).toHaveLength(1_026);
    expect(entries.filter((entry) => entry.signature === null)).toHaveLength(2);
    expect(entries.filter((entry) => entry.unread)).toHaveLength(1);
    expect(entries.filter((entry) => entry.signature !== null)).toHaveLength(1_024);
  });

  it('retains the newest 1024 terminals from a newest-first complete catalog', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const newestFirst = Array.from({ length: 1_025 }, (_, index) =>
      terminal(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: `catalog-${index}`,
            workspace: { kind: 'local', projectPath: `/workspace/catalog-${index}` },
          },
          rootId: `catalog-${index}`,
        })
      )
    );

    await store.reconcile(newestFirst);

    const keys = (await readStoredFile(target)).entries.map((entry) => entry.key);
    expect(keys).toHaveLength(1_024);
    expect(keys).toContain(digestLocator(newestFirst[0]!.locator));
    expect(keys).not.toContain(digestLocator(newestFirst.at(-1)!.locator));
    expect(keys.at(-1)).toBe(digestLocator(newestFirst[0]!.locator));
  });

  it('keeps newest-first terminal compaction stable across identical reconciles', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const newestFirst = Array.from({ length: 1_025 }, (_, index) =>
      terminal(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: `stable-${index}`,
            workspace: { kind: 'local', projectPath: `/workspace/stable-${index}` },
          },
          rootId: `stable-${index}`,
        })
      )
    );
    await store.reconcile(newestFirst);
    const firstKeys = (await readStoredFile(target)).entries.map((entry) => entry.key);

    await store.reconcile(newestFirst);

    const secondKeys = (await readStoredFile(target)).entries.map((entry) => entry.key);
    expect(secondKeys).toEqual(firstKeys);
    expect(secondKeys).toEqual(
      newestFirst
        .slice(0, 1_024)
        .reverse()
        .map((summary) => digestLocator(summary.locator))
    );
    expect(secondKeys).not.toContain(digestLocator(newestFirst[1_024]!.locator));
  });

  it('retains a newly discovered recent terminal as a silent baseline', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const existingNewestFirst = Array.from({ length: 1_024 }, (_, index) =>
      terminal(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: `existing-${index}`,
            workspace: { kind: 'local', projectPath: `/workspace/existing-${index}` },
          },
          rootId: `existing-${index}`,
        })
      )
    );
    await store.reconcile(existingNewestFirst);
    const recent = terminal(
      createLocalSummary({
        locator: {
          version: 2,
          sessionId: 'recent-terminal',
          workspace: { kind: 'local', projectPath: '/workspace/recent-terminal' },
        },
        rootId: 'recent-terminal',
        lastMessageTime: '2026-09-04T13:00:00.000Z',
      }),
      'completed',
      '2026-09-04T13:00:00.000Z'
    );

    const snapshot = await store.reconcile([recent, ...existingNewestFirst]);

    const keys = (await readStoredFile(target)).entries.map((entry) => entry.key);
    expect(snapshot.unreadKeys).toEqual([]);
    expect(keys).toHaveLength(1_024);
    expect(keys).toContain(digestLocator(recent.locator));
    expect(keys).not.toContain(digestLocator(existingNewestFirst.at(-1)!.locator));
    expect(store.snapshot().unreadKeys).toEqual([]);
  });

  it('moves exact acknowledgements to the MRU end before terminal compaction', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const acknowledged = Array.from({ length: 1_025 }, (_, index) =>
      terminal(
        createLocalSummary({
          locator: {
            version: 2,
            sessionId: `mru-${index}`,
            workspace: { kind: 'local', projectPath: `/workspace/mru-${index}` },
          },
          rootId: `mru-${index}`,
        })
      )
    );
    await store.reconcile(acknowledged);
    const before = await readStoredFile(target);
    expect(before.entries).toHaveLength(1_024);
    const oldestRetained = acknowledged[1_023]!;
    const oldestRetainedKey = digestLocator(oldestRetained.locator);
    expect(oldestRetainedKey).toBeDefined();

    await store.acknowledge(oldestRetained);

    const after = await readStoredFile(target);
    expect(after.entries).toHaveLength(1_024);
    expect(after.entries.at(-1)?.key).toBe(oldestRetainedKey);
    expect(after.entries[0]?.key).not.toBe(oldestRetainedKey);
  });

  it('retains the computed in-memory snapshot when persistence fails', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const baseline = new TuiTaskAttentionStore({ filePath: target });
    const running = createLocalSummary();
    await baseline.reconcile([running]);
    const diagnostics: string[] = [];
    const store = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: async () => {
        throw new Error('secret injected persistence failure');
      },
      reportDiagnostic: (message) => diagnostics.push(message),
    });

    const snapshot = await store.reconcile([terminal(running)]);

    expect(snapshot.unreadKeys).toHaveLength(1);
    expect(store.snapshot()).toEqual(snapshot);
    expect(diagnostics).toEqual(['TUI task attention persistence unavailable']);
    expect(diagnostics.join('')).not.toContain('secret');
    expect((await readStoredFile(target)).entries[0]).toMatchObject({
      signature: null,
      unread: false,
    });
  });

  it('replays a failed acknowledgement over another store update without reviving it', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const first = createLocalSummary();
    const second = createRemoteSummary();
    const firstTerminal = terminal(first);
    const secondTerminal = terminal(second, 'failed');
    const baseline = new TuiTaskAttentionStore({ filePath: target });
    await baseline.reconcile([first, second]);
    await baseline.reconcile([firstTerminal, second]);
    let writes = 0;
    const store = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: async (targetPath, data, options) => {
        writes++;
        if (writes === 1) throw new Error('transient write failure');
        await writeFileAtomic(targetPath, data, options);
      },
    });

    expect((await store.acknowledge(firstTerminal)).unreadKeys).toEqual([]);
    const otherStore = new TuiTaskAttentionStore({ filePath: target });
    expect(
      (await otherStore.reconcile([first, secondTerminal])).unreadKeys
    ).toHaveLength(2);

    const snapshot = await store.reconcile([firstTerminal, secondTerminal]);

    expect(snapshot.unreadKeys).toEqual([digestLocator(second.locator)]);
  });

  it('replays a failed unread reconcile over another store update', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const first = createLocalSummary();
    const second = createRemoteSummary();
    const firstTerminal = terminal(first);
    const secondTerminal = terminal(second, 'failed');
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([first, second]);
    let writes = 0;
    const store = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: async (targetPath, data, options) => {
        writes++;
        if (writes === 1) throw new Error('transient write failure');
        await writeFileAtomic(targetPath, data, options);
      },
    });

    expect((await store.reconcile([firstTerminal, second])).unreadKeys).toEqual([
      digestLocator(first.locator),
    ]);
    const otherStore = new TuiTaskAttentionStore({ filePath: target });
    expect((await otherStore.reconcile([first, secondTerminal])).unreadKeys).toEqual([
      digestLocator(second.locator),
    ]);

    const snapshot = await store.reconcile([firstTerminal, secondTerminal]);

    expect(new Set(snapshot.unreadKeys)).toEqual(
      new Set([digestLocator(first.locator), digestLocator(second.locator)])
    );
  });

  it('preserves running-to-terminal evidence across consecutive failed reconciles', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const first = createLocalSummary();
    const second = createRemoteSummary();
    const firstTerminal = terminal(first);
    let writes = 0;
    const store = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: async (targetPath, data, options) => {
        writes++;
        if (writes <= 2) throw new Error('transient write failure');
        await writeFileAtomic(targetPath, data, options);
      },
    });

    expect((await store.reconcile([first, second])).unreadKeys).toEqual([]);
    expect((await store.reconcile([firstTerminal, second])).unreadKeys).toEqual([
      digestLocator(first.locator),
    ]);
    await new TuiTaskAttentionStore({ filePath: target }).acknowledge(second);

    const snapshot = await store.acknowledge(second);

    expect(snapshot.unreadKeys).toEqual([digestLocator(first.locator)]);
    const persisted = await readStoredFile(target);
    expect(persisted.entries).toHaveLength(2);
    expect(
      persisted.entries.find((entry) => entry.key === digestLocator(first.locator))
    ).toMatchObject({ signature: null, unread: true });
  });

  it('journals transient read failures without overwriting disk as empty', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const first = createLocalSummary();
    const second = createRemoteSummary();
    const firstTerminal = terminal(first);
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([first, second]);
    const store = new TuiTaskAttentionStore({ filePath: target });
    await store.reconcile([first, second]);
    const before = await readFile(target, 'utf8');
    let opens = 0;
    const close = vi.fn(async () => undefined);
    const failingStore = new TuiTaskAttentionStore({
      filePath: target,
      openFile: async (targetPath, flags) => {
        opens++;
        if (opens === 2) {
          return {
            readFile: async () => {
              const error = new Error('transient read failure');
              Object.assign(error, { code: 'EIO' });
              throw error;
            },
            close,
          };
        }
        return open(targetPath, flags);
      },
    });
    await failingStore.reconcile([first, second]);

    expect((await failingStore.reconcile([firstTerminal, second])).unreadKeys).toEqual([
      digestLocator(first.locator),
    ]);
    expect(await readFile(target, 'utf8')).toBe(before);
    expect(close).toHaveBeenCalledOnce();
    await new TuiTaskAttentionStore({ filePath: target }).acknowledge(second);

    const snapshot = await failingStore.reconcile([firstTerminal, second]);

    expect(snapshot.unreadKeys).toEqual([digestLocator(first.locator)]);
    expect((await readStoredFile(target)).entries).toHaveLength(2);
  });

  it('journals a compromised lock mutation and prevents its guarded write', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const running = createLocalSummary();
    const completed = terminal(running);
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([running]);
    let lockAttempts = 0;
    const write = vi.fn(
      async (targetPath: string, data: string, options: { mode: number }) =>
        writeFileAtomic(targetPath, data, options)
    );
    const diagnostics: string[] = [];
    const store = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: write,
      lockFile: async (_targetPath, options) => {
        lockAttempts++;
        if (lockAttempts === 1) {
          options.onCompromised?.(new Error('secret compromise details'));
        }
        return async () => undefined;
      },
      reportDiagnostic: (message) => diagnostics.push(message),
    });

    expect((await store.reconcile([completed])).unreadKeys).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(['TUI task attention persistence unavailable']);

    expect((await store.reconcile([completed])).unreadKeys).toHaveLength(1);
    expect(write).toHaveBeenCalledOnce();
  });

  it('retains a mutation when compromise arrives while its writer is blocked', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const first = createLocalSummary();
    const second = createRemoteSummary();
    const firstTerminal = terminal(first);
    const secondTerminal = terminal(second, 'failed');
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([first, second]);
    let compromised: ((error: Error) => void) | undefined;
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let lockAttempts = 0;
    const store = new TuiTaskAttentionStore({
      filePath: target,
      lockFile: async (targetPath, options) => {
        lockAttempts++;
        if (lockAttempts === 1) {
          compromised = options.onCompromised;
          return async () => undefined;
        }
        const lockfile = await import('proper-lockfile');
        return lockfile.lock(targetPath, options);
      },
      writeFile: async (targetPath, data, options) => {
        if (lockAttempts === 1) {
          signalWriteStarted();
          await blockedWrite;
          return;
        }
        await writeFileAtomic(targetPath, data, options);
      },
    });

    const firstMutation = store.reconcile([firstTerminal, second]);
    await writeStarted;
    compromised?.(new Error('asynchronous compromise'));
    releaseWrite();
    expect((await firstMutation).unreadKeys).toEqual([digestLocator(first.locator)]);
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([
      first,
      secondTerminal,
    ]);

    const snapshot = await store.acknowledge(secondTerminal);

    expect(snapshot.unreadKeys).toEqual([digestLocator(first.locator)]);
    expect((await readStoredFile(target)).entries).toHaveLength(2);
  });

  it('treats atomic write as commit even when permission hardening fails', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const running = createLocalSummary();
    const completed = terminal(running);
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([running]);
    let chmodAttempts = 0;
    const store = new TuiTaskAttentionStore({
      filePath: target,
      chmodFile: async (targetPath, mode) => {
        chmodAttempts++;
        if (chmodAttempts === 1) throw new Error('chmod unavailable');
        await chmod(targetPath, mode);
      },
    });

    expect((await store.acknowledge(completed)).unreadKeys).toEqual([]);
    await new TuiTaskAttentionStore({ filePath: target }).reconcile([running]);

    const snapshot = await store.reconcile([completed]);

    expect(snapshot.unreadKeys).toEqual([digestLocator(running.locator)]);
  });

  it('keeps a bounded failed-mutation journal fail closed after overflow', async () => {
    const root = await temporaryRoot();
    const blockedPath = path.join(root, 'blocked');
    await writeFile(blockedPath, 'not a directory');
    const store = new TuiTaskAttentionStore({
      filePath: path.join(blockedPath, 'attention.json'),
    });
    const summary = terminal(createLocalSummary());

    for (let index = 0; index < 257; index++) {
      await store.acknowledge({
        ...summary,
        taskCompletedAt: new Date(Date.parse(COMPLETED_AT) + index).toISOString(),
      });
    }
    await rm(blockedPath, { force: true });

    await expect(store.acknowledge(summary)).resolves.toEqual({ unreadKeys: [] });
    await expect(
      readFile(path.join(blockedPath, 'attention.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deduplicates catalog locators by their first newest-first occurrence', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const first = terminal(createLocalSummary(), 'completed', COMPLETED_AT);
    const duplicate = terminal(first, 'failed', LATER_COMPLETED_AT);

    await store.reconcile([first, duplicate]);

    expect((await readStoredFile(target)).entries).toEqual([
      {
        key: digestLocator(first.locator),
        signature: JSON.stringify(['completed', COMPLETED_AT]),
        unread: false,
      },
    ]);
  });

  it('keeps the exact attempted acknowledgement in memory after a write failure', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const baseline = new TuiTaskAttentionStore({ filePath: target });
    const running = createLocalSummary();
    await baseline.reconcile([running]);
    const store = new TuiTaskAttentionStore({ filePath: target });
    expect((await store.reconcile([terminal(running)])).unreadKeys).toHaveLength(1);
    const failingStore = new TuiTaskAttentionStore({
      filePath: target,
      writeFile: async () => {
        throw new Error('write unavailable');
      },
    });
    expect((await failingStore.reconcile([terminal(running)])).unreadKeys).toHaveLength(
      1
    );

    const snapshot = await failingStore.acknowledge(terminal(running));

    expect(snapshot.unreadKeys).toEqual([]);
    expect(failingStore.snapshot()).toEqual(snapshot);
  });

  it('fails soft when the attention path cannot be locked', async () => {
    const root = await temporaryRoot();
    const blockedPath = path.join(root, 'blocked');
    await writeFile(blockedPath, 'not a directory');
    const diagnostics: string[] = [];
    const store = new TuiTaskAttentionStore({
      filePath: path.join(blockedPath, 'attention.json'),
      reportDiagnostic: (message) => diagnostics.push(message),
    });

    await expect(store.reconcile([terminal(createLocalSummary())])).resolves.toEqual({
      unreadKeys: [],
    });
    expect(diagnostics).toEqual(['TUI task attention persistence unavailable']);
  });

  it('applies complete-catalog pruning to memory when a later lock attempt fails', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const diagnostics: string[] = [];
    const store = new TuiTaskAttentionStore({
      filePath: target,
      reportDiagnostic: (message) => diagnostics.push(message),
    });
    const running = createLocalSummary();
    await store.reconcile([running]);
    await store.reconcile([terminal(running)]);
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not a directory');

    const snapshot = await store.reconcile([]);

    expect(snapshot.unreadKeys).toEqual([]);
    expect(store.snapshot()).toEqual(snapshot);
    expect(diagnostics).toEqual(['TUI task attention persistence unavailable']);
  });

  it('applies exact acknowledgement to an existing unread snapshot when locking fails', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const running = createLocalSummary();
    const completed = terminal(running);
    await store.reconcile([running]);
    expect((await store.reconcile([completed])).unreadKeys).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not a directory');

    const snapshot = await store.acknowledge(completed);

    expect(snapshot.unreadKeys).toEqual([]);
    expect(store.snapshot()).toEqual(snapshot);
  });

  it('applies terminal transitions and complete-catalog pruning when locking fails', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    const store = new TuiTaskAttentionStore({ filePath: target });
    const first = createLocalSummary();
    const second = createRemoteSummary();
    await store.reconcile([first, second]);
    expect((await store.reconcile([first, terminal(second)])).unreadKeys).toEqual([
      digestLocator(second.locator),
    ]);
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not a directory');

    const snapshot = await store.reconcile([terminal(first)]);

    expect(snapshot.unreadKeys).toEqual([digestLocator(first.locator)]);
    expect(store.snapshot()).toEqual(snapshot);
  });

  it('uses the storage root default and enforces private directory and file modes', async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    vi.stubEnv('BLADE_STORAGE_ROOT', root);
    const store = new TuiTaskAttentionStore();

    await store.reconcile([createLocalSummary()]);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath(root))).mode & 0o777).toBe(0o600);
  });

  it('preserves both exact digest mutations from concurrent Bun processes', async () => {
    const root = await temporaryRoot();
    const lockHeldPath = path.join(root, 'writer-a-lock-held');
    const releasePath = path.join(root, 'writer-a-release');
    const attemptPath = path.join(root, 'writer-b-attempt');
    const completedPath = path.join(root, 'writer-b-completed');

    const firstWriter = runWriter(root, 'a');
    let secondWriter: Promise<void> | undefined;
    try {
      await waitForFile(lockHeldPath);
      secondWriter = runWriter(root, 'b');
      await waitForFile(attemptPath);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(await fileExists(completedPath)).toBe(false);
    } finally {
      await writeFile(releasePath, 'release').catch(() => undefined);
    }
    await firstWriter;
    await secondWriter;
    expect(await fileExists(completedPath)).toBe(true);

    const entries = (await readStoredFile(filePath(root))).entries;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    expect(entries.every((entry) => entry.signature !== null)).toBe(true);
    expect(entries.every((entry) => !entry.unread)).toBe(true);
  });
});
