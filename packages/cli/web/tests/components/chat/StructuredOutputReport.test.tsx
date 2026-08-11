// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseStructuredOutputReport,
  StructuredOutputReport,
} from '@/components/chat/StructuredOutputReport';
import { setLocale } from '@/i18n';

describe('StructuredOutputReport', () => {
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
    setLocale('en');
  });

  it('renders a canonical structured payload with localized chrome', async () => {
    setLocale('zh');
    const report = parseStructuredOutputReport({
      output: { summary: 'done', files: 2 },
      schemaDigest: 'a'.repeat(64),
    });
    expect(report).toBeDefined();

    await act(async () => {
      root.render(<StructuredOutputReport report={report!} />);
    });

    expect(container.querySelector('[data-structured-output]')).toBeTruthy();
    expect(container.textContent).toContain('结构化输出');
    expect(container.textContent).toContain('"summary": "done"');
    expect(container.textContent).toContain('sha256:aaaaaaaaaa');
  });

  it('fails closed for malformed metadata', () => {
    expect(
      parseStructuredOutputReport({ output: ['not', 'an', 'object'] })
    ).toBeUndefined();
    expect(
      parseStructuredOutputReport({ schemaDigest: 'a'.repeat(64) })
    ).toBeUndefined();
  });
});
