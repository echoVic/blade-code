// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendComposerDraftContext,
  clearComposerDraft,
  readComposerDraft,
  subscribeComposerDraftAppend,
  writeComposerDraft,
} from '../../src/lib/composerDraft';

const DRAFT_KEY = 'session:["/project","session-1"]';

describe('composerDraft context append', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearComposerDraft(DRAFT_KEY);
  });

  it('appends context without discarding attachments or output schema', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeComposerDraftAppend(listener);
    writeComposerDraft(DRAFT_KEY, {
      content: 'Fix the selected component',
      attachments: [
        {
          id: 'image-1',
          name: 'context.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
        },
      ],
      outputSchema: '{"type":"object"}',
    });

    expect(
      appendComposerDraftContext(
        DRAFT_KEY,
        '<browser_element_context trust="untrusted">element</browser_element_context>'
      )
    ).toBe(true);

    const draft = readComposerDraft(DRAFT_KEY);
    expect(draft.content).toBe(
      'Fix the selected component\n\n' +
        '<browser_element_context trust="untrusted">element</browser_element_context>'
    );
    expect(draft.attachments).toHaveLength(1);
    expect(draft.outputSchema).toBe('{"type":"object"}');
    expect(listener).toHaveBeenCalledWith({ key: DRAFT_KEY, draft });
    unsubscribe();
  });

  it('ignores empty or unscoped context', () => {
    expect(appendComposerDraftContext(undefined, 'element')).toBe(false);
    expect(appendComposerDraftContext(DRAFT_KEY, '   ')).toBe(false);
    expect(readComposerDraft(DRAFT_KEY).content).toBe('');
  });
});
