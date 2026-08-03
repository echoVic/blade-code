import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseInput = vi.fn();
const mockUseStdout = vi.fn(() => ({ stdout: { columns: 120 } }));
const mockSelectInput = vi.fn(
  ({ items }: { items: Array<{ label: string; key: string }> }) =>
    React.createElement(
      'select-input',
      { 'data-items': items.map((item) => item.label).join('|') },
      null
    )
);
const mockUseCurrentFocus = vi.fn(() => 'confirmation_prompt');
const mockCtrlCHandler = vi.fn(() => vi.fn());

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
  useStdout: () => mockUseStdout(),
}));

vi.mock('ink-select-input', () => ({
  default: (props: unknown) => mockSelectInput(props as never),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => mockUseCurrentFocus(),
}));

vi.mock('../../../../src/store/types.js', () => ({
  FocusId: {
    CONFIRMATION_PROMPT: 'confirmation_prompt',
  },
}));

vi.mock('../../../../src/ui/hooks/useCtrlCHandler.js', () => ({
  useCtrlCHandler: () => mockCtrlCHandler(),
}));

vi.mock('../../../../src/ui/components/MessageRenderer.js', () => ({
  MessageRenderer: ({ content }: { content: string }) =>
    React.createElement('message-renderer', { 'data-content': content }, content),
}));

describe('ConfirmationPrompt', () => {
  let inputHandler: ((input: string, key: Record<string, boolean>) => void) | undefined;

  beforeEach(() => {
    inputHandler = undefined;
    mockUseInput.mockReset();
    mockUseInput.mockImplementation((handler: typeof inputHandler) => {
      inputHandler = handler;
    });
    mockSelectInput.mockClear();
    mockUseCurrentFocus.mockReset();
    mockUseCurrentFocus.mockReturnValue('confirmation_prompt');
    mockUseStdout.mockReset();
    mockUseStdout.mockReturnValue({ stdout: { columns: 120 } });
    mockCtrlCHandler.mockReset();
    mockCtrlCHandler.mockReturnValue(vi.fn());
  });

  it('覆盖长风险列表、长文件列表，并支持 S 快捷键批准会话级授权', async () => {
    const { ConfirmationPrompt } = await import(
      '../../../../src/ui/components/ConfirmationPrompt.js'
    );

    const onResponse = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ConfirmationPrompt, {
        details: {
          type: 'permission',
          title: 'Write Permission',
          message: 'Apply the requested edit?',
          risks: [
            '会修改 headless 输出协议',
            'May affect CI snapshots',
            '需要更新 benchmark 历史记录',
            '可能暴露新的阶段事件',
            '需要校准消费端解析',
          ],
          affectedFiles: [
            'packages/cli/src/commands/headless.ts',
            'packages/cli/src/commands/headlessEvents.ts',
            'packages/cli/tests/unit/cli/headless.test.ts',
            'packages/cli/tests/unit/cli/headless-events.test.ts',
            'packages/cli/tests/unit/platform/ui/ConfirmationPrompt.test.tsx',
            'packages/cli/tests/performance/benchmarks/real-repo-benchmark.test.ts',
          ],
        },
        onResponse,
      })
    );

    expect(html).toContain('风险提示:');
    expect(html).toContain('会修改 headless 输出协议');
    expect(html).toContain('May affect CI snapshots');
    expect(html).toContain('影响的文件:');
    expect(html).toContain('packages/cli/src/commands/headless.ts');
    expect(html).toContain('...还有 3 个文件');
    expect(html).toContain('[S] 允许（本次会话）');
    expect(html).toContain('Y/S/P/N 快捷键');

    inputHandler?.('s', { ctrl: false, meta: false, escape: false });

    expect(onResponse).toHaveBeenCalledWith({
      approved: true,
      scope: 'session',
    });
  });

  it('通过独立的 P 快捷键明确批准项目级持久授权', async () => {
    const { ConfirmationPrompt } = await import(
      '../../../../src/ui/components/ConfirmationPrompt.js'
    );
    const onResponse = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ConfirmationPrompt, {
        details: {
          type: 'permission',
          title: 'Bash Permission',
          message: 'Run the command?',
        },
        onResponse,
      })
    );

    expect(html).toContain('[P] 允许并记住（本项目）');
    inputHandler?.('p', { ctrl: false, meta: false, escape: false });
    expect(onResponse).toHaveBeenCalledWith({
      approved: true,
      scope: 'project',
    });
  });

  it('进入规划模式时应保持选项与快捷键文案一致，并支持 N 快捷键', async () => {
    const { ConfirmationPrompt } = await import(
      '../../../../src/ui/components/ConfirmationPrompt.js'
    );

    const onResponse = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ConfirmationPrompt, {
        details: {
          type: 'enterPlanMode',
          message: 'Review the implementation plan before editing code.',
        },
        onResponse,
      })
    );

    expect(html).toContain('进入规划模式');
    expect(html).toContain('[Y] 进入规划模式');
    expect(html).toContain('[N] 直接执行');
    expect(html).toContain('Y/N 快捷键');
    expect(html).not.toContain('Y/S/N 快捷键');

    inputHandler?.('n', { ctrl: false, meta: false, escape: false });

    expect(onResponse).toHaveBeenCalledWith({
      approved: false,
      reason: '用户拒绝进入 Plan 模式',
    });
  });
});
