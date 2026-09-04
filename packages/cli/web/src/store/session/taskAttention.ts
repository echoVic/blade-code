import type { Session, SessionRef } from '@api/schemas';
import { taskFailureCode } from '@/lib/taskFailure';
import { sessionRefKey } from './sessionIdentity';

const UNREAD_TASKS_KEY = 'blade.tasks.unread';
const TASK_TERMINAL_READ_LEDGER_KEY = 'blade.tasks.terminal-read-ledger.v1';
const MAX_TASK_TERMINAL_READ_LEDGER_KEY_LENGTH = 16_384;
const MAX_ACKNOWLEDGED_TERMINAL_ENTRIES = 1_024;
export const TASK_NOTIFICATION_OPEN_EVENT = 'blade:open-session';

export interface TaskTerminalReadLedgerEntry {
  key: string;
  signature: string | null;
}

export interface TaskTerminalReadLedgerV1 {
  version: 1;
  entries: TaskTerminalReadLedgerEntry[];
}

export type TaskTerminalState = Pick<
  Session,
  'taskStatus' | 'taskCompletedAt' | 'taskFailure'
>;

export type AttentionTaskStatus = Extract<
  Session['taskStatus'],
  'completed' | 'failed' | 'interrupted'
>;

export function isAttentionTaskStatus(
  status: Session['taskStatus']
): status is AttentionTaskStatus {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export function shouldMarkTaskUnread(
  previousStatus: Session['taskStatus'] | undefined,
  nextStatus: Session['taskStatus'],
  isCurrentVisible: boolean
): boolean {
  if (!isAttentionTaskStatus(nextStatus) || isCurrentVisible) return false;
  return (
    previousStatus !== nextStatus &&
    !(
      previousStatus === 'completed' ||
      previousStatus === 'failed' ||
      previousStatus === 'interrupted' ||
      previousStatus === 'cancelled'
    )
  );
}

function emptyTaskTerminalReadLedger(): TaskTerminalReadLedgerV1 {
  return { version: 1, entries: [] };
}

function canonicalDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function taskTerminalSignature(state: TaskTerminalState): string | null {
  if (!isAttentionTaskStatus(state.taskStatus)) return null;
  return JSON.stringify([
    state.taskStatus,
    canonicalDate(state.taskCompletedAt),
    taskFailureCode(state.taskFailure?.code) ?? null,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsoluteProjectPath(projectPath: string): boolean {
  if (projectPath.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(projectPath)) return true;
  if (!projectPath.startsWith('\\\\')) return false;
  const [server, share] = projectPath.slice(2).split(/[\\/]/);
  return Boolean(server && share);
}

function isValidSessionRefKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_TASK_TERMINAL_READ_LEDGER_KEY_LENGTH) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !isAbsoluteProjectPath(parsed[0]) ||
      parsed[1].length === 0
    ) {
      return false;
    }
    return sessionRefKey({ projectPath: parsed[0], sessionId: parsed[1] }) === key;
  } catch {
    return false;
  }
}

function isCanonicalTerminalSignature(signature: string): boolean {
  try {
    const parsed: unknown = JSON.parse(signature);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      !isAttentionTaskStatus(parsed[0])
    ) {
      return false;
    }
    const completedAt = parsed[1];
    if (
      completedAt !== null &&
      (typeof completedAt !== 'string' || canonicalDate(completedAt) !== completedAt)
    ) {
      return false;
    }
    const failureCode =
      parsed[2] === null ? null : (taskFailureCode(parsed[2]) ?? undefined);
    if (failureCode === undefined) return false;
    return JSON.stringify([parsed[0], completedAt, failureCode]) === signature;
  } catch {
    return false;
  }
}

function parseTaskTerminalReadLedgerEntry(
  value: unknown
): TaskTerminalReadLedgerEntry | null {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    !isValidSessionRefKey(value.key) ||
    (value.signature !== null &&
      (typeof value.signature !== 'string' ||
        !isCanonicalTerminalSignature(value.signature)))
  ) {
    return null;
  }
  return { key: value.key, signature: value.signature };
}

export function readTaskTerminalReadLedger(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): TaskTerminalReadLedgerV1 {
  if (!storage) return emptyTaskTerminalReadLedger();
  try {
    const raw = storage.getItem(TASK_TERMINAL_READ_LEDGER_KEY);
    if (raw === null) return emptyTaskTerminalReadLedger();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return emptyTaskTerminalReadLedger();
    }
    const entries = new Map<string, TaskTerminalReadLedgerEntry>();
    for (const candidate of parsed.entries) {
      const entry = parseTaskTerminalReadLedgerEntry(candidate);
      if (!entry) continue;
      entries.delete(entry.key);
      entries.set(entry.key, entry);
    }
    return { version: 1, entries: [...entries.values()] };
  } catch {
    return emptyTaskTerminalReadLedger();
  }
}

export function persistTaskTerminalReadLedger(
  ledger: TaskTerminalReadLedgerV1,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(TASK_TERMINAL_READ_LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // The in-memory ledger remains authoritative when storage is unavailable.
  }
}

export function acknowledgeTaskTerminal(
  ledger: TaskTerminalReadLedgerV1,
  ref: SessionRef,
  state: TaskTerminalState
): TaskTerminalReadLedgerV1 {
  const key = sessionRefKey(ref);
  return {
    version: 1,
    entries: [
      ...ledger.entries.filter((entry) => entry.key !== key),
      { key, signature: taskTerminalSignature(state) },
    ],
  };
}

export function pruneAndCompactTaskTerminalReadLedger(input: {
  ledger: TaskTerminalReadLedgerV1;
  sessions: readonly Session[];
  unreadTaskKeys: readonly string[];
}): TaskTerminalReadLedgerV1 {
  const activeKeys = new Set(
    input.sessions.map((session) =>
      sessionRefKey({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      })
    )
  );
  const unreadKeys = new Set(input.unreadTaskKeys);
  const activeEntries = input.ledger.entries.filter((entry) =>
    activeKeys.has(entry.key)
  );
  const compactableEntries = activeEntries.filter(
    (entry) => entry.signature !== null && !unreadKeys.has(entry.key)
  );
  const entriesToEvict = new Set(
    compactableEntries.slice(
      0,
      Math.max(0, compactableEntries.length - MAX_ACKNOWLEDGED_TERMINAL_ENTRIES)
    )
  );
  return {
    version: 1,
    entries: activeEntries.filter((entry) => !entriesToEvict.has(entry)),
  };
}

export function reconcileTaskAttention(input: {
  ledger: TaskTerminalReadLedgerV1;
  unreadTaskKeys: readonly string[];
  sessions: readonly Session[];
  currentSessionRef: SessionRef | null;
  documentVisible: boolean;
}): { ledger: TaskTerminalReadLedgerV1; unreadTaskKeys: string[] } {
  const entries = new Map<string, TaskTerminalReadLedgerEntry>();
  for (const entry of input.ledger.entries) {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
  }
  const unreadKeys = new Set(input.unreadTaskKeys);
  const visibleCurrentKey =
    input.documentVisible && input.currentSessionRef
      ? sessionRefKey(input.currentSessionRef)
      : null;

  const acknowledge = (key: string, signature: string | null): void => {
    entries.delete(key);
    entries.set(key, { key, signature });
  };

  for (const session of input.sessions) {
    const key = sessionRefKey({
      sessionId: session.sessionId,
      projectPath: session.projectPath,
    });
    const signature = taskTerminalSignature(session);
    if (!entries.has(key)) {
      acknowledge(key, signature);
      if (visibleCurrentKey === key) unreadKeys.delete(key);
      continue;
    }
    if (visibleCurrentKey === key) {
      acknowledge(key, signature);
      unreadKeys.delete(key);
      continue;
    }
    if (signature === null) {
      acknowledge(key, null);
      continue;
    }
    if (entries.get(key)?.signature !== signature) unreadKeys.add(key);
  }

  const activeKeys = new Set(
    input.sessions.map((session) =>
      sessionRefKey({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      })
    )
  );
  const nextUnreadTaskKeys = [...unreadKeys].filter((key) => activeKeys.has(key));
  const ledger = pruneAndCompactTaskTerminalReadLedger({
    ledger: { version: 1, entries: [...entries.values()] },
    sessions: input.sessions,
    unreadTaskKeys: nextUnreadTaskKeys,
  });

  return { ledger, unreadTaskKeys: nextUnreadTaskKeys };
}

export function readUnreadTaskKeys(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(UNREAD_TASKS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter((value): value is string => typeof value === 'string')
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function persistUnreadTaskKeys(
  keys: readonly string[],
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(UNREAD_TASKS_KEY, JSON.stringify([...new Set(keys)]));
  } catch {
    // The in-memory unread state remains useful when storage is unavailable.
  }
}

export function pruneUnreadTaskKeys(
  keys: readonly string[],
  sessions: readonly Session[]
): string[] {
  const existing = new Set(
    sessions.map((session) =>
      sessionRefKey({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      })
    )
  );
  return keys.filter((key) => existing.has(key));
}

export function showTaskNotification(input: {
  ref: SessionRef;
  title: string;
  body: string;
  onOpen: (ref: SessionRef) => void;
}): boolean {
  if (
    typeof document === 'undefined' ||
    document.visibilityState !== 'hidden' ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return false;
  }
  const notification = new Notification(input.title, {
    body: input.body,
    icon: '/favicon.svg',
    tag: `blade-task-${sessionRefKey(input.ref)}`,
  });
  notification.onclick = () => input.onOpen(input.ref);
  return true;
}

export function playTaskAttentionSound(status: AttentionTaskStatus): boolean {
  if (typeof window === 'undefined') return false;
  const AudioContextClass =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!AudioContextClass) return false;
  try {
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = status === 'completed' ? 660 : 330;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    oscillator.onended = () => void context.close();
    return true;
  } catch {
    return false;
  }
}
