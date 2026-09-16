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

  it('rejects oversized files without using partial state', async () => {
    const root = await temporaryRoot();
    const target = filePath(root);
    await writeFile(target, ' '.repeat(4 * 1024 * 1024 + 1));

    const store = new TuiTaskAttentionStore({ filePath: target });

    await expect(store.reconcile([terminal(createLocalSummary())])).resolves.toEqual({
      unreadKeys: [],
    });
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
});
