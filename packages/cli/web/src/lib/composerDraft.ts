export interface ComposerDraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ComposerDraftSnapshot {
  content: string;
  attachments: ComposerDraftAttachment[];
  outputSchema?: string;
}

export interface ComposerDraftAppendEvent {
  key: string;
  draft: ComposerDraftSnapshot;
}

const STORAGE_PREFIX = 'blade.composer.draft.';
const drafts = new Map<string, ComposerDraftSnapshot>();
const appendListeners = new Set<(event: ComposerDraftAppendEvent) => void>();
const STORAGE_VERSION = 1;

function storage(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

export function readComposerDraft(key?: string): ComposerDraftSnapshot {
  if (!key) return { content: '', attachments: [], outputSchema: undefined };
  const memoryDraft = drafts.get(key);
  if (memoryDraft) {
    return {
      content: memoryDraft.content,
      attachments: [...memoryDraft.attachments],
      outputSchema: memoryDraft.outputSchema,
    };
  }

  try {
    const raw = storage()?.getItem(storageKey(key)) ?? '';
    if (!raw) return { content: '', attachments: [], outputSchema: undefined };
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (
        value.version === STORAGE_VERSION &&
        typeof value.content === 'string' &&
        (value.outputSchema === undefined || typeof value.outputSchema === 'string')
      ) {
        return {
          content: value.content,
          attachments: [],
          outputSchema: value.outputSchema as string | undefined,
        };
      }
    } catch {
      // Legacy drafts stored the raw composer text.
    }
    return { content: raw, attachments: [], outputSchema: undefined };
  } catch {
    return { content: '', attachments: [], outputSchema: undefined };
  }
}

export function writeComposerDraft(
  key: string | undefined,
  draft: ComposerDraftSnapshot
): void {
  if (!key) return;
  const current = drafts.get(key);
  const outputSchema = draft.outputSchema ?? current?.outputSchema;
  if (!draft.content && draft.attachments.length === 0 && !outputSchema) {
    clearComposerDraft(key);
    return;
  }

  drafts.set(key, {
    content: draft.content,
    attachments: [...draft.attachments],
    outputSchema,
  });
  try {
    if (draft.content || outputSchema) {
      storage()?.setItem(
        storageKey(key),
        JSON.stringify({
          version: STORAGE_VERSION,
          content: draft.content,
          ...(outputSchema ? { outputSchema } : {}),
        })
      );
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

export function appendComposerDraftContext(
  key: string | undefined,
  context: string
): boolean {
  const addition = context.trim();
  if (!key || !addition) return false;
  const current = readComposerDraft(key);
  const separator =
    current.content.length === 0 ? '' : current.content.endsWith('\n') ? '\n' : '\n\n';
  const draft = {
    ...current,
    content: `${current.content}${separator}${addition}`,
  };
  writeComposerDraft(key, draft);
  const event = {
    key,
    draft: {
      ...draft,
      attachments: [...draft.attachments],
    },
  };
  for (const listener of appendListeners) listener(event);
  return true;
}

export function subscribeComposerDraftAppend(
  listener: (event: ComposerDraftAppendEvent) => void
): () => void {
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}
