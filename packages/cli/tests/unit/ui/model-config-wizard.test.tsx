import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('ink-text-input', () => ({
  default: ({ value, placeholder }: { value?: string; placeholder?: string }) =>
    React.createElement('text-input', {
      value,
      placeholder,
    }),
}));

vi.mock('ink-select-input', () => ({
  default: ({ items }: { items: Array<{ key: string; label: string }> }) =>
    React.createElement('select-input', {
      'data-items': items.map((item) => item.label).join('|'),
    }),
}));

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  icon: '',
  description: 'Reasoning models',
  envVars: ['DEEPSEEK_API_KEY'],
};

describe('model config wizard flow', () => {
  it('API Key 提交后应先进入 Base URL 步骤，并且从模型页返回 Base URL', async () => {
    const { getPreviousWizardStep, getStepAfterApiKeySubmit } = await import(
      '../../../src/ui/components/model-config/wizardFlow.js'
    );

    expect(getStepAfterApiKeySubmit()).toBe('baseUrl');
    expect(getPreviousWizardStep('model')).toBe('baseUrl');
  });
});

describe('BaseUrlInput', () => {
  it('应提示默认 Base URL 已预填且允许手动修改', async () => {
    const { BaseUrlInput } = await import(
      '../../../src/ui/components/model-config/index.js'
    );

    const html = renderToStaticMarkup(
      React.createElement(BaseUrlInput, {
        provider,
        value: 'https://api.deepseek.com/v1',
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      })
    );

    expect(html).toContain('默认值已预填');
    expect(html).toContain('手动修改');
  });
});

describe('ModelSelector', () => {
  it('应明确提示可以按 + 手动输入 Model ID', async () => {
    const { ModelSelector } = await import(
      '../../../src/ui/components/model-config/ModelSelector.js'
    );

    const html = renderToStaticMarkup(
      React.createElement(ModelSelector, {
        provider,
        models: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
          },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
          },
        ],
        isLoading: false,
        error: null,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      })
    );

    expect(html).toContain('按 + 手动输入 Model ID');
    expect(html).toContain('deepseek-v4-pro');
  });
});
