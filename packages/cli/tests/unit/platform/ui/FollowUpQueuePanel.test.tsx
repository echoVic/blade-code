// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpQueueSnapshot } from '../../../../src/api/followUpQueueSchemas.js';

const input = vi.hoisted(() => ({
  handler: undefined as
    | ((value: string, key: Record<string, boolean>) => boolean | void)
    | undefined,
}));
const terminal = vi.hoisted(() => ({ width: 80, height: 24 }));

vi.mock('ink', () => ({
  Box: ({ children, ...props }: { children?: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: { children?: React.ReactNode }) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock('../../../../src/ui/input/TerminalInputRouter.js', () => ({
  useTerminalInput: (
    handler: (value: string, key: Record<string, boolean>) => boolean | void,
    options?: { isActive?: boolean }
  ) => {
    input.handler = options?.isActive === false ? undefined : handler;
  },
}));

vi.mock('../../../../src/ui/hooks/useTerminalDimensions.js', () => ({
  useTerminalDimensions: () => terminal,
}));

import { FollowUpQueuePanel } from '../../../../src/ui/components/FollowUpQueuePanel.js';

function snapshot(withBarrier = true): FollowUpQueueSnapshot {
  const items: FollowUpQueueSnapshot['items'] = [
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
    ...(withBarrier
      ? [
          {
            id: 'internal',
            position: 1,
            queuedAt: '2026-09-05T00:00:01.000Z',
            kind: 'internal' as const,
            state: 'locked' as const,
            delivery: 'current_turn' as const,
            mutable: false,
            previewTruncated: false,
            attachmentCount: 0,
          },
        ]
      : []),
    {
      id: 'last',
      position: withBarrier ? 2 : 1,
      queuedAt: '2026-09-05T00:00:02.000Z',
      kind: 'user',
      state: 'pending',
      delivery: 'next_turn',
      mutable: true,
      preview: 'Run the final checks after the queue is reordered',
      previewTruncated: false,
      attachmentCount: 1,
    },
  ];
  return {
    version: 'a'.repeat(64),
    pending: items.length,
    mutable: 2,
    locked: withBarrier ? 1 : 0,
    internal: withBarrier ? 1 : 0,
    items,
  };
}

describe('FollowUpQueuePanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    input.handler = undefined;
    terminal.width = 80;
    terminal.height = 24;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('navigates rows, protects barriers, refreshes, and closes without aborting', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={snapshot()}
          mutation={{ pending: false }}
          onMutate={onMutate}
          onRefresh={onRefresh}
          onClose={onClose}
        />
      );
    });

    expect(container.textContent).toContain('Follow-up queue · 3');
    expect(container.textContent).toContain('Internal runtime item');

    act(() => input.handler?.('j', {}));
    act(() => input.handler?.('d', {}));
    expect(onMutate).not.toHaveBeenCalled();

    act(() => input.handler?.('j', {}));
    act(() => input.handler?.('K', { shift: true }));
    expect(onMutate).not.toHaveBeenCalled();

    await act(async () => {
      input.handler?.('r', {});
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledOnce();

    act(() => input.handler?.('', { escape: true }));
    act(() => input.handler?.('q', {}));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('supports arrows, delete, one-step moves, and segment start/end moves', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={snapshot(false)}
          mutation={{ pending: false }}
          onMutate={onMutate}
          onRefresh={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    act(() => input.handler?.('', { downArrow: true }));
    await act(async () => {
      input.handler?.('d', {});
      await Promise.resolve();
    });
    expect(onMutate).toHaveBeenNthCalledWith(1, {
      type: 'remove',
      messageId: 'last',
    });

    act(() => input.handler?.('', { upArrow: true }));
    await act(async () => {
      input.handler?.('J', { shift: true });
      input.handler?.('G', { shift: true });
      await Promise.resolve();
    });
    expect(onMutate).toHaveBeenNthCalledWith(2, {
      type: 'move',
      messageId: 'first',
      toPosition: 1,
    });
    expect(onMutate).toHaveBeenNthCalledWith(3, {
      type: 'move',
      messageId: 'first',
      toPosition: 1,
    });
  });

  it('supports k and g while retaining the selected durable identity', async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    const original = snapshot(false);
    original.items = [
      ...original.items,
      {
        ...original.items[1]!,
        id: 'third',
        position: 2,
        preview: 'Ship the final result',
        attachmentCount: 0,
      },
    ];
    original.pending = 3;
    original.mutable = 3;
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={original}
          mutation={{ pending: false }}
          onMutate={onMutate}
          onRefresh={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    act(() => input.handler?.('j', {}));
    act(() => input.handler?.('j', {}));
    act(() => input.handler?.('k', {}));
    await act(async () => {
      input.handler?.('K', { shift: true });
      input.handler?.('g', {});
      await Promise.resolve();
    });

    expect(onMutate).toHaveBeenNthCalledWith(1, {
      type: 'move',
      messageId: 'last',
      toPosition: 0,
    });
    expect(onMutate).toHaveBeenNthCalledWith(2, {
      type: 'move',
      messageId: 'last',
      toPosition: 0,
    });
  });

  it('retains selection across a stale refresh and truncates narrow previews', async () => {
    terminal.width = 50;
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const original = snapshot(false);
    await act(async () => {
      root.render(
        <FollowUpQueuePanel
          queue={original}
          mutation={{ pending: false }}
          onMutate={vi.fn()}
          onRefresh={onRefresh}
          onClose={vi.fn()}
        />
      );
    });
    act(() => input.handler?.('j', {}));

    const replacement = {
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
          queue={replacement}
          mutation={{ pending: false, errorCode: 'revision_conflict' }}
          onMutate={vi.fn()}
          onRefresh={onRefresh}
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(onRefresh).not.toHaveBeenCalled();
    expect(
      container.querySelector('span[color="cyan"]')?.parentElement?.textContent
    ).toContain('Run the fin…');
    expect(container.textContent).toContain('Queue changed; showing the latest order');
    expect(container.textContent).not.toContain(
      'Run the final checks after the queue is reordered'
    );
  });
});
