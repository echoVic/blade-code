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
const MAX_PENDING_MUTATIONS = 256;
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
type AttentionFileHandle = Pick<fs.FileHandle, 'readFile' | 'close'>;
type AttentionFileOpener = (
  filePath: string,
  flags: string
) => Promise<AttentionFileHandle>;
type AttentionFileLocker = (
  filePath: string,
  options: LockOptions
) => Promise<() => Promise<void>>;

interface AttentionEntry {
  key: string;
  signature: string | null;
  unread: boolean;
}

interface AttentionFileV1 {
  version: typeof VERSION;
  entries: AttentionEntry[];
}

type AttentionMutation =
  | {
      kind: 'reconcile';
      sessions: readonly SessionSurfaceSummary[];
      visibleLocator?: SessionLocatorV2;
    }
  | { kind: 'acknowledge'; summary: SessionSurfaceSummary };

export interface TuiTaskAttentionSnapshot {
  readonly unreadKeys: readonly string[];
}

export interface TuiTaskAttentionStoreOptions {
  filePath?: string;
  writeFile?: AtomicWriter;
  openFile?: AttentionFileOpener;
  lockFile?: AttentionFileLocker;
  reportDiagnostic?: (message: string) => void;
}

let lockfileModule: LockfileModule | undefined;

export class TuiTaskAttentionStore {
  private static readonly operations = new KeyedMutexRegistry<string>();

  private readonly filePath: string;
  private readonly writeFile: AtomicWriter;
  private readonly openFile: AttentionFileOpener;
  private readonly lockFile: AttentionFileLocker;
  private readonly reportDiagnostic: (message: string) => void;
  private entries: AttentionEntry[] = [];
  private pending: AttentionMutation[] = [];
  private journalOverflowed = false;

  constructor(options: TuiTaskAttentionStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(getBladeStorageRoot(), FILE_NAME);
    this.writeFile = options.writeFile ?? writeFileAtomic;
    this.openFile = options.openFile ?? fs.open;
    this.lockFile = options.lockFile ?? lockAttentionFile;
    this.reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
  }

  reconcile(
    sessions: readonly SessionSurfaceSummary[],
    visibleLocator?: SessionLocatorV2
  ): Promise<TuiTaskAttentionSnapshot> {
    return this.mutate({ kind: 'reconcile', sessions, visibleLocator });
  }

  acknowledge(summary: SessionSurfaceSummary): Promise<TuiTaskAttentionSnapshot> {
    return this.mutate({ kind: 'acknowledge', summary });
  }

  snapshot(): TuiTaskAttentionSnapshot {
    return snapshotFrom(this.entries);
  }

  private async mutate(mutation: AttentionMutation): Promise<TuiTaskAttentionSnapshot> {
    return TuiTaskAttentionStore.operations.runExclusive(this.filePath, async () => {
      let release: (() => Promise<void>) | undefined;
      let next: AttentionEntry[] | undefined;
      let compromised = false;
      try {
        await ensurePrivateDirectory(this.filePath);
        release = await this.lockFile(this.filePath, {
          ...LOCK_OPTIONS,
          onCompromised: () => {
            compromised = true;
          },
        });
        const latest = await readAttentionFile(this.filePath, this.openFile);
        if (this.journalOverflowed) {
          throw new Error('attention mutation journal overflowed');
        }
        next = applyMutations(latest, [...this.pending, mutation]);
        this.entries = next;
        if (compromised) throw new Error('attention file lock compromised');
        const serialized = JSON.stringify({ version: VERSION, entries: next }, null, 2);
        await this.writeFile(this.filePath, serialized + '\n', { mode: 0o600 });
        await fs.chmod(this.filePath, 0o600);
        this.pending = [];
      } catch {
        if (next === undefined) {
          next = applyMutation(this.entries, mutation);
          this.entries = next;
        }
        this.enqueue(mutation);
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

  private enqueue(mutation: AttentionMutation): void {
    if (this.journalOverflowed) return;
    if (mutation.kind === 'reconcile') {
      const last = this.pending.at(-1);
      if (last?.kind === 'reconcile') this.pending[this.pending.length - 1] = mutation;
      else this.pending.push(mutation);
    } else {
      this.pending.push(mutation);
    }
    if (this.pending.length > MAX_PENDING_MUTATIONS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_MUTATIONS);
      this.journalOverflowed = true;
    }
  }
}

function applyMutations(
  entries: readonly AttentionEntry[],
  mutations: readonly AttentionMutation[]
): AttentionEntry[] {
  return mutations.reduce<AttentionEntry[]>(
    (state, mutation) => {
      return applyMutation(state, mutation);
    },
    [...entries]
  );
}

function applyMutation(
  entries: readonly AttentionEntry[],
  mutation: AttentionMutation
): AttentionEntry[] {
  if (mutation.kind === 'reconcile') {
    return compactEntries(
      reconcileEntries(entries, mutation.sessions, mutation.visibleLocator)
    );
  }
  const key = digestLocator(mutation.summary.locator);
  return compactEntries(
    moveToMru(entries, {
      key,
      signature: terminalSignature(mutation.summary),
      unread: false,
    })
  );
}

function reconcileEntries(
  current: readonly AttentionEntry[],
  sessions: readonly SessionSurfaceSummary[],
  visibleLocator: SessionLocatorV2 | undefined
): AttentionEntry[] {
  const currentByKey = new Map(current.map((entry) => [entry.key, entry]));
  const seen = new Set<string>();
  const visibleKey = visibleLocator ? digestLocator(visibleLocator) : undefined;
  let visibleSummary: SessionSurfaceSummary | undefined;
  const protectedEntries: AttentionEntry[] = [];
  const acknowledgedTerminals: AttentionEntry[] = [];

  for (const session of sessions) {
    const key = digestLocator(session.locator);
    if (seen.has(key)) continue;
    seen.add(key);
    const signature = terminalSignature(session);
    if (visibleKey === key) {
      visibleSummary = session;
      continue;
    }
    const previous = currentByKey.get(key);

    if (!previous) {
      const baseline = { key, signature, unread: false };
      if (signature === null) protectedEntries.push(baseline);
      else acknowledgedTerminals.push(baseline);
      continue;
    }
    if (signature === null) {
      protectedEntries.push({ key, signature: null, unread: previous.unread });
      continue;
    }
    if (previous.signature !== signature) {
      protectedEntries.push({ ...previous, unread: true });
      continue;
    }
    if (previous.unread) protectedEntries.push(previous);
    else acknowledgedTerminals.push(previous);
  }
  let entries = [
    ...acknowledgedTerminals.slice(0, MAX_ACKNOWLEDGED_TERMINAL_ENTRIES).reverse(),
    ...protectedEntries.reverse(),
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

async function readAttentionFile(
  filePath: string,
  openFile: AttentionFileOpener
): Promise<AttentionEntry[]> {
  let handle: AttentionFileHandle | undefined;
  try {
    handle = await openFile(filePath, 'r');
    const content = await handle.readFile();
    if (content.byteLength > MAX_FILE_BYTES) return [];
    const value: unknown = JSON.parse(content.toString('utf8'));
    return parseAttentionFile(value)?.entries ?? [];
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT')
    ) {
      return [];
    }
    throw error;
  } finally {
    await handle?.close();
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

async function lockAttentionFile(
  filePath: string,
  options: LockOptions
): Promise<() => Promise<void>> {
  const lockfile = await getLockfile();
  return lockfile.lock(filePath, options);
}
