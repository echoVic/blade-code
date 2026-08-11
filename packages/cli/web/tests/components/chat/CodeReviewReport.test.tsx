// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodeReviewReport,
  parseCodeReviewReport,
} from '@/components/chat/CodeReviewReport';
import { setLocale } from '@/i18n';

const metadata = {
  phase: 'completed',
  status: 'completed',
  target: {
    kind: 'uncommitted',
    label: 'uncommitted changes',
  },
  overallExplanation: 'The authorization check is unsafe.',
  findings: [
    {
      title: '[P0] Restore equality comparison',
      body: 'Assignment makes every request pass.',
      priority: 0,
      confidenceScore: 0.99,
      codeLocation: {
        path: 'authorization.ts',
        lineStart: 8,
        lineEnd: 8,
      },
    },
  ],
};

describe('CodeReviewReport', () => {
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

  it('renders canonical review metadata with localized structural chrome', async () => {
    const report = parseCodeReviewReport(metadata);
    expect(report).toBeDefined();
    setLocale('zh');
    await act(async () => {
      root.render(<CodeReviewReport report={report!} />);
    });

    expect(container.textContent).toContain('代码评审');
    expect(container.textContent).toContain('目标: 未提交改动');
    expect(container.textContent).toContain('状态: 已完成');
    expect(container.textContent).toContain('authorization.ts:L8');
    expect(container.textContent).toContain('置信度 0.99');
  });

  it('fails closed for malformed persisted metadata', () => {
    expect(
      parseCodeReviewReport({
        ...metadata,
        findings: [{ title: '[P0] Missing required fields' }],
      })
    ).toBeUndefined();
  });
});
