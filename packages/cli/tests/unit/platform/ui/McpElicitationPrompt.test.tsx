import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseInput = vi.fn();
const mockTextInput = vi.fn((_props?: unknown) => React.createElement('text-input'));

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
  useStdout: () => ({ stdout: { columns: 120 } }),
}));

vi.mock('ink-text-input', () => ({
  default: (props: unknown) => mockTextInput(props),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => 'confirmation_prompt',
}));

vi.mock('../../../../src/store/types.js', () => ({
  FocusId: {
    CONFIRMATION_PROMPT: 'confirmation_prompt',
  },
}));

vi.mock('../../../../src/ui/hooks/useCtrlCHandler.js', () => ({
  useCtrlCHandler: () => vi.fn(),
}));

describe('McpElicitationPrompt', () => {
  let inputHandler: ((input: string, key: Record<string, boolean>) => void) | undefined;

  beforeEach(() => {
    inputHandler = undefined;
    mockUseInput.mockReset();
    mockUseInput.mockImplementation((handler: typeof inputHandler) => {
      inputHandler = handler;
    });
    mockTextInput.mockClear();
  });

  it('renders a URL security boundary and only accepts on explicit Y', async () => {
    const { McpElicitationPrompt } = await import(
      '../../../../src/ui/components/McpElicitationPrompt.js'
    );
    const onComplete = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(McpElicitationPrompt, {
        details: {
          serverName: 'deploy',
          mode: 'url',
          message: 'Authorize deployment',
          domain: 'deploy.example.test',
          url: 'https://deploy.example.test/authorize?state=opaque',
          elicitationId: 'auth-1',
        },
        onComplete,
      })
    );

    expect(html).toContain('MCP external authorization');
    expect(html).toContain('deploy.example.test');
    expect(html).toContain('https://deploy.example.test/authorize?state=opaque');
    inputHandler?.('y', { ctrl: false, meta: false, escape: false });
    expect(onComplete).toHaveBeenCalledWith({ action: 'accept' }, true);
  });

  it('renders typed form metadata without exposing a generic permission prompt', async () => {
    const { McpElicitationPrompt } = await import(
      '../../../../src/ui/components/McpElicitationPrompt.js'
    );
    const html = renderToStaticMarkup(
      React.createElement(McpElicitationPrompt, {
        details: {
          serverName: 'deploy',
          mode: 'form',
          message: 'Configure release',
          requestedSchema: {
            type: 'object',
            properties: {},
          },
          fields: [
            {
              name: 'owner',
              type: 'string',
              title: 'Owner',
              description: 'Release owner email',
              required: true,
              format: 'email',
              minLength: 3,
            },
          ],
        },
        onComplete: vi.fn(),
      })
    );

    expect(html).toContain('MCP input requested by');
    expect(html).toContain('Owner');
    expect(html).toContain('format: email');
    expect(html).toContain('min length: 3');
    expect(mockTextInput).toHaveBeenCalledOnce();
  });
});
