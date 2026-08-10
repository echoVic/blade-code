import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseInput = vi.fn();

vi.mock('ink', () => ({
  Box: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('div', props, children),
  Text: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('span', props, children),
  useInput: (...args: unknown[]) => mockUseInput(...args),
}));

describe('WorkspaceTrustPrompt', () => {
  let inputHandler: ((input: string, key: Record<string, boolean>) => void) | undefined;

  beforeEach(() => {
    inputHandler = undefined;
    mockUseInput.mockReset();
    mockUseInput.mockImplementation((handler: typeof inputHandler) => {
      inputHandler = handler;
    });
  });

  it('renders blocked sources and trusts on Enter', async () => {
    const { WorkspaceTrustPrompt } = await import(
      '../../../../src/ui/components/WorkspaceTrustPrompt.js'
    );
    const onTrust = vi.fn(async () => undefined);
    const onContinueSafely = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceTrustPrompt, {
        status: {
          projectPath: '/workspace/project',
          trustRoot: '/workspace/project',
          state: 'untrusted',
          trusted: false,
          sensitiveSources: 1,
          decision: 'undecided',
          sources: [
            {
              path: '.blade/config.json',
              kind: 'config',
              keys: ['mcpServers'],
              effects: [{ kind: 'mcp', name: 'project', target: 'node server.js' }],
            },
          ],
        },
        onTrust,
        onContinueSafely,
      })
    );

    expect(html).toContain('Workspace review required');
    expect(html).toContain('.blade/config.json');
    expect(html).toContain('Trust and load');
    inputHandler?.('', { return: true });
    expect(onTrust).toHaveBeenCalledOnce();
    expect(onContinueSafely).not.toHaveBeenCalled();
  });

  it('continues with filtered configuration on Escape', async () => {
    const { WorkspaceTrustPrompt } = await import(
      '../../../../src/ui/components/WorkspaceTrustPrompt.js'
    );
    const onTrust = vi.fn(async () => undefined);
    const onContinueSafely = vi.fn(async () => undefined);
    renderToStaticMarkup(
      React.createElement(WorkspaceTrustPrompt, {
        status: {
          projectPath: '/workspace/project',
          trustRoot: '/workspace/project',
          state: 'untrusted',
          trusted: false,
          sensitiveSources: 1,
          decision: 'undecided',
          sources: [],
        },
        onTrust,
        onContinueSafely,
      })
    );

    inputHandler?.('', { escape: true });
    expect(onContinueSafely).toHaveBeenCalledOnce();
    expect(onTrust).not.toHaveBeenCalled();
  });
});
