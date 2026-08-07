export interface ComposerDraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ComposerDraftSnapshot {
  content: string;
  attachments: ComposerDraftAttachment[];
}

const STORAGE_PREFIX = 'blade.composer.draft.';
const drafts = new Map<string, ComposerDraftSnapshot>();

function storage(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

export function readComposerDraft(key?: string): ComposerDraftSnapshot {
  if (!key) return { content: '', attachments: [] };
  const memoryDraft = drafts.get(key);
  if (memoryDraft) {
    return {
      content: memoryDraft.content,
      attachments: [...memoryDraft.attachments],
    };
  }

  try {
    const content = storage()?.getItem(storageKey(key)) ?? '';
    return { content, attachments: [] };
  } catch {
    return { content: '', attachments: [] };
  }
}

export function writeComposerDraft(
  key: string | undefined,
  draft: ComposerDraftSnapshot
): void {
  if (!key) return;
  if (!draft.content && draft.attachments.length === 0) {
    clearComposerDraft(key);
    return;
  }

  drafts.set(key, {
    content: draft.content,
    attachments: [...draft.attachments],
  });
  try {
    if (draft.content) {
      storage()?.setItem(storageKey(key), draft.content);
    } else {
      storage()?.removeItem(storageKey(key));
    }
  } catch {
    // In-memory isolation still works when browser storage is unavailable.
  }
}

export function clearComposerDraft(key?: string): void {
  if (!key) return;
  drafts.delete(key);
  try {
    storage()?.removeItem(storageKey(key));
  } catch {
    // Browser storage may be disabled or full.
  }
}
