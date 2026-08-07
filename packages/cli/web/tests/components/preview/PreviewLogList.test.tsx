// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PreviewLogList } from '../../../src/components/preview/PreviewLogList';

describe('PreviewLogList', () => {
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

  test('renders long tool histories in progressive windows', async () => {
    const logs = Array.from({ length: 205 }, (_, index) => ({
      id: `tool-${index}`,
      title: `Tool ${index}`,
      status: 'success' as const,
      content: `Output ${index}`,
    }));

    act(() => {
      root.render(<PreviewLogList logs={logs} />);
    });

    expect(container.querySelectorAll('[data-preview-log-id]')).toHaveLength(80);
    const showMore = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show 80 more logs')
    );
    if (!showMore) throw new Error('Progressive log action was not rendered');

    await act(async () => showMore.click());
    expect(container.querySelectorAll('[data-preview-log-id]')).toHaveLength(160);
  });
});
