// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type PreviewDiffEntry,
  PreviewDiffList,
} from '../../../src/components/preview/PreviewDiffList';

describe('PreviewDiffList', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('bounds initial file and patch-line DOM while progressively revealing more', async () => {
    const patch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join(
      '\n'
    );
    const diffs: PreviewDiffEntry[] = Array.from({ length: 45 }, (_, index) => ({
      filePath: `src/file-${index}.ts`,
      diff: { patch },
      summary: '+500 -0',
    }));

    act(() => {
      root.render(
        <PreviewDiffList
          diffs={diffs}
          expanded={{}}
          targetPath={null}
          onToggle={vi.fn()}
          onSetAllExpanded={vi.fn()}
        />
      );
    });

    expect(container.querySelectorAll('[data-preview-diff-path]')).toHaveLength(20);
    expect(container.querySelectorAll('[data-preview-diff-line]')).toHaveLength(160);

    const moreLines = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show 240 more lines')
    );
    if (!moreLines) throw new Error('Progressive line action was not rendered');
    await act(async () => moreLines.click());
    expect(container.querySelectorAll('[data-preview-diff-line]')).toHaveLength(400);

    const moreFiles = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show 20 more files')
    );
    if (!moreFiles) throw new Error('Progressive file action was not rendered');
    await act(async () => moreFiles.click());
    expect(container.querySelectorAll('[data-preview-diff-path]')).toHaveLength(40);
  });
});
