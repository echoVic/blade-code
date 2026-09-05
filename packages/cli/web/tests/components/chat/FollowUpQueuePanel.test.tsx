// @vitest-environment jsdom

import type { FollowUpQueueSnapshot } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpQueuePanel } from '../../../src/components/chat/FollowUpQueuePanel';
import { setLocale } from '../../../src/i18n';

function queue(): FollowUpQueueSnapshot {
  return {
    version: 'a'.repeat(64),
    pending: 3,
    mutable: 2,
    locked: 1,
    internal: 1,
    items: [
      {
        id: 'first',
        position: 0,
        queuedAt: '2026-09-05T00:00:00.000Z',
        kind: 'user',
        state: 'pending',
        delivery: 'current_turn',
        mutable: true,
        preview: 'Inspect the transport contract',
        previewTruncated: false,
        attachmentCount: 0,
      },
      {
        id: 'internal',
        position: 1,
        queuedAt: '2026-09-05T00:00:01.000Z',
        kind: 'internal',
        state: 'locked',
        delivery: 'current_turn',
        mutable: false,
        previewTruncated: false,
        attachmentCount: 0,
      },
      {
        id: 'third',
        position: 2,
        queuedAt: '2026-09-05T00:00:02.000Z',
        kind: 'user',
        state: 'pending',
        delivery: 'next_turn',
        mutable: true,
        preview: 'Run the final checks',
        previewTruncated: false,
        attachmentCount: 1,
      },
    ],
  };
}

describe('FollowUpQueuePanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders pending, locked, and internal rows without internal content', async () => {
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={queue()}
          mutation={{ pending: false, supersededVersions: [] }}
          onMutate={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('3 queued');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });
    expect(container.textContent).toContain('Inspect the transport contract');
    expect(container.textContent).toContain('Run the final checks');
    expect(container.textContent).toContain('Internal runtime item');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove follow-up internal"]'
      )?.disabled
    ).toBe(true);
  });

  it('exposes accessible remove and reorder controls with barrier boundaries', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={queue()}
          mutation={{ pending: false, supersededVersions: [] }}
          onMutate={onMutate}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Move first up"]')
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Move first down"]')
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Move third up"]')
        ?.disabled
    ).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove follow-up first"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onMutate).toHaveBeenCalledWith({ type: 'remove', messageId: 'first' });
  });

  it('shows a localized stale-state notice and refresh action', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={queue()}
          mutation={{
            pending: false,
            errorCode: 'revision_conflict',
            errorMessage: 'raw server message',
            supersededVersions: [],
          }}
          onMutate={vi.fn()}
          onRefresh={onRefresh}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Queue changed elsewhere'
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh follow-up queue"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('supports drag reordering inside one mutable segment', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    const movable = queue();
    movable.items.splice(1, 1);
    movable.pending = 2;
    movable.locked = 0;
    movable.internal = 0;
    movable.items[1] = { ...movable.items[1]!, position: 1 };
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={movable}
          mutation={{ pending: false, supersededVersions: [] }}
          onMutate={onMutate}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });
    const first = container.querySelector<HTMLElement>('[data-follow-up-id="first"]');
    const third = container.querySelector<HTMLElement>('[data-follow-up-id="third"]');
    await act(async () => {
      first?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      third?.dispatchEvent(new Event('drop', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onMutate).toHaveBeenCalledWith({
      type: 'move',
      messageId: 'first',
      toPosition: 1,
    });
  });

  it('disables every queue action while a mutation is pending', async () => {
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={queue()}
          mutation={{
            pending: true,
            messageId: 'first',
            supersededVersions: [],
          }}
          onMutate={vi.fn()}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });

    const actionButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Move "], [aria-label^="Remove follow-up "]'
    );
    expect(actionButtons.length).toBeGreaterThan(0);
    expect(Array.from(actionButtons).every((button) => button.disabled)).toBe(true);
  });

  it('restores focus to the moved item after a replacement snapshot', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    const original = queue();
    original.items.splice(1, 1);
    original.pending = 2;
    original.locked = 0;
    original.internal = 0;
    original.items[1] = { ...original.items[1]!, position: 1 };
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={original}
          mutation={{ pending: false, supersededVersions: [] }}
          onMutate={onMutate}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show follow-up queue"]')
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Move first down"]')
        ?.click();
      await Promise.resolve();
    });
    const moved = {
      ...original,
      version: 'b'.repeat(64),
      items: [
        { ...original.items[1]!, position: 0 },
        { ...original.items[0]!, position: 1 },
      ],
    };
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={moved}
          mutation={{ pending: false, supersededVersions: [] }}
          onMutate={onMutate}
        />
      );
    });
    expect(document.activeElement).toBe(
      container.querySelector('[data-follow-up-focus-id="first"]')
    );
  });
});
