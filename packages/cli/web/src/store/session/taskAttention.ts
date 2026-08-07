import type { Session, SessionRef } from '@api/schemas';
import { sessionRefKey } from './sessionIdentity';

const UNREAD_TASKS_KEY = 'blade.tasks.unread';
export const TASK_NOTIFICATION_OPEN_EVENT = 'blade:open-session';

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
