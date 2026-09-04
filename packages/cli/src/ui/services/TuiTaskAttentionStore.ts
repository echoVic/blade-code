import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import type {
  SessionLocatorV2,
  SessionSurfaceSummary,
} from '../../api/sessionSurfaceSchemas.js';
import { getBladeStorageRoot } from '../../context/storage/BladeStorageRoot.js';
import { KeyedMutexRegistry } from '../../utils/KeyedMutexRegistry.js';

const VERSION = 1 as const;
const FILE_NAME = 'tui-task-attention-v1.json';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_ENTRIES = 20_000;
const MAX_ACKNOWLEDGED_TERMINAL_ENTRIES = 1_024;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  retries: {
    retries: 150,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
};

type LockfileModule = typeof import('proper-lockfile');
type AtomicWriter = (
  filePath: string,
  data: string,
  options: { mode: number }
) => Promise<void>;

interface AttentionEntry {
  key: string;
  signature: string | null;
  unread: boolean;
}

interface AttentionFileV1 {
  version: typeof VERSION;
  entries: AttentionEntry[];
}

export interface TuiTaskAttentionSnapshot {
  readonly unreadKeys: readonly string[];
}

export interface TuiTaskAttentionStoreOptions {
  filePath?: string;
  writeFile?: AtomicWriter;
  reportDiagnostic?: (message: string) => void;
}

let lockfileModule: LockfileModule | undefined;

export class TuiTaskAttentionStore {
  private static readonly operations = new KeyedMutexRegistry<string>();

  private readonly filePath: string;
  private readonly writeFile: AtomicWriter;
  private readonly reportDiagnostic: (message: string) => void;
  private entries: AttentionEntry[] = [];

  constructor(options: TuiTaskAttentionStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(getBladeStorageRoot(), FILE_NAME);
    this.writeFile = options.writeFile ?? writeFileAtomic;
    this.reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
  }

  reconcile(
    sessions: readonly SessionSurfaceSummary[],
    visibleLocator?: SessionLocatorV2
  ): Promise<TuiTaskAttentionSnapshot> {
    return this.mutate((current) =>
      reconcileEntries(current, sessions, visibleLocator)
    );
  }

  acknowledge(summary: SessionSurfaceSummary): Promise<TuiTaskAttentionSnapshot> {
    return this.mutate((current) => {
      const key = digestLocator(summary.locator);
      return moveToMru(current, {
        key,
        signature: terminalSignature(summary),
        unread: false,
      });
    });
  }

  snapshot(): TuiTaskAttentionSnapshot {
    return snapshotFrom(this.entries);
  }

  private async mutate(
    operation: (entries: readonly AttentionEntry[]) => AttentionEntry[]
  ): Promise<TuiTaskAttentionSnapshot> {
    return TuiTaskAttentionStore.operations.runExclusive(this.filePath, async () => {
      let release: (() => Promise<void>) | undefined;
      let next: AttentionEntry[] | undefined;
      try {
        await ensurePrivateDirectory(this.filePath);
        const lockfile = await getLockfile();
        release = await lockfile.lock(this.filePath, LOCK_OPTIONS);
        const latest = await readAttentionFile(this.filePath);
        next = compactEntries(operation(latest));
        this.entries = next;
        const serialized = JSON.stringify({ version: VERSION, entries: next }, null, 2);
        await this.writeFile(this.filePath, serialized + '\n', { mode: 0o600 });
        await fs.chmod(this.filePath, 0o600);
      } catch {
        if (next === undefined) {
          next = compactEntries(operation(this.entries));
          this.entries = next;
        }
        this.reportDiagnostic('TUI task attention persistence unavailable');
      } finally {
        if (release) {
          try {
            await release();
          } catch {
            this.reportDiagnostic('TUI task attention persistence unavailable');
          }
        }
      }
      return snapshotFrom(this.entries);
    });
  }
}

function reconcileEntries(
  current: readonly AttentionEntry[],
  sessions: readonly SessionSurfaceSummary[],
  visibleLocator: SessionLocatorV2 | undefined
): AttentionEntry[] {
  const activeKeys = new Set(sessions.map((session) => digestLocator(session.locator)));
  let entries = current.filter((entry) => activeKeys.has(entry.key));
  const visibleKey = visibleLocator ? digestLocator(visibleLocator) : undefined;
  let visibleSummary: SessionSurfaceSummary | undefined;
  const missingTerminals: AttentionEntry[] = [];
  const missingNonTerminals: AttentionEntry[] = [];

  for (const session of sessions) {
    const key = digestLocator(session.locator);
    const signature = terminalSignature(session);
    if (visibleKey === key) {
      visibleSummary = session;
      continue;
    }
    const index = entries.findIndex((entry) => entry.key === key);
    const previous = entries[index];

    if (!previous) {
      const baseline = { key, signature, unread: false };
      if (signature === null) missingNonTerminals.push(baseline);
      else missingTerminals.push(baseline);
      continue;
    }
    if (signature === null) {
      entries[index] = { key, signature: null, unread: previous.unread };
      continue;
    }
    if (previous.signature !== signature) {
      entries[index] = { ...previous, unread: true };
    }
  }
  entries = [
    ...missingTerminals.reverse(),
    ...entries,
    ...missingNonTerminals.reverse(),
  ];
  if (visibleSummary) {
    entries = moveToMru(entries, {
      key: digestLocator(visibleSummary.locator),
      signature: terminalSignature(visibleSummary),
      unread: false,
    });
  }
  return entries;
}

function compactEntries(entries: readonly AttentionEntry[]): AttentionEntry[] {
  const acknowledgedTerminalIndexes = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.signature !== null && !entry.unread)
    .map(({ index }) => index);
  const evict = new Set(
    acknowledgedTerminalIndexes.slice(
      0,
      Math.max(
        0,
        acknowledgedTerminalIndexes.length - MAX_ACKNOWLEDGED_TERMINAL_ENTRIES
      )
    )
  );
  return entries.filter((_entry, index) => !evict.has(index));
}

function moveToMru(
  entries: readonly AttentionEntry[],
  entry: AttentionEntry
): AttentionEntry[] {
  return [...entries.filter((candidate) => candidate.key !== entry.key), entry];
}

function snapshotFrom(entries: readonly AttentionEntry[]): TuiTaskAttentionSnapshot {
  return Object.freeze({
    unreadKeys: Object.freeze(
      entries.filter((entry) => entry.unread).map((entry) => entry.key)
    ),
  });
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

function terminalSignature(summary: SessionSurfaceSummary): string | null {
  if (
    summary.taskStatus !== 'completed' &&
    summary.taskStatus !== 'failed' &&
    summary.taskStatus !== 'interrupted'
  ) {
    return null;
  }
  return JSON.stringify([summary.taskStatus, summary.taskCompletedAt ?? null]);
}

function parseTerminalSignature(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      (parsed[0] !== 'completed' &&
        parsed[0] !== 'failed' &&
        parsed[0] !== 'interrupted')
    ) {
      return false;
    }
    if (
      parsed[1] !== null &&
      (typeof parsed[1] !== 'string' ||
        !CANONICAL_TIMESTAMP_PATTERN.test(parsed[1]) ||
        new Date(parsed[1]).toISOString() !== parsed[1])
    ) {
      return false;
    }
    return JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttentionFile(value: unknown): AttentionFileV1 | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => field !== 'version' && field !== 'entries') ||
    value.version !== VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_FILE_ENTRIES
  ) {
    return undefined;
  }
  const keys = new Set<string>();
  const entries: AttentionEntry[] = [];
  for (const valueEntry of value.entries) {
    if (
      !isRecord(valueEntry) ||
      Object.keys(valueEntry).some(
        (field) => field !== 'key' && field !== 'signature' && field !== 'unread'
      ) ||
      typeof valueEntry.key !== 'string' ||
      !DIGEST_PATTERN.test(valueEntry.key) ||
      keys.has(valueEntry.key) ||
      (valueEntry.signature !== null &&
        (typeof valueEntry.signature !== 'string' ||
          !parseTerminalSignature(valueEntry.signature))) ||
      typeof valueEntry.unread !== 'boolean'
    ) {
      return undefined;
    }
    keys.add(valueEntry.key);
    entries.push({
      key: valueEntry.key,
      signature: valueEntry.signature,
      unread: valueEntry.unread,
    });
  }
  return { version: VERSION, entries };
}

async function readAttentionFile(filePath: string): Promise<AttentionEntry[]> {
  try {
    const info = await fs.stat(filePath);
    if (info.size > MAX_FILE_BYTES) return [];
    const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parseAttentionFile(value)?.entries ?? [];
  } catch {
    return [];
  }
}

async function ensurePrivateDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function getLockfile(): Promise<LockfileModule> {
  lockfileModule ??= await import('proper-lockfile');
  return lockfileModule;
}
