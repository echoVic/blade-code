import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('ahooks', () => ({
  useMemoizedFn: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));

vi.mock('ink', () => ({
  Box: ({
    children,
    borderColor,
  }: {
    children?: React.ReactNode;
    borderColor?: string;
  }) => React.createElement('div', { 'data-border-color': borderColor }, children),
  Text: ({ children, color }: { children?: React.ReactNode; color?: string }) =>
    React.createElement('span', { 'data-color': color }, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => 'main-input',
}));

vi.mock('../../../../src/ui/components/CustomTextInput.js', () => ({
  CustomTextInput: ({ value, focus }: { value: string; focus?: boolean }) =>
    React.createElement('span', { 'data-focus': String(focus), 'data-input': value }),
}));

import { InputArea } from '../../../../src/ui/components/InputArea.js';

function renderInput(input: string, disabled = false): string {
  return renderToStaticMarkup(
    <InputArea
      input={input}
      cursorPosition={input.length}
      onChange={() => undefined}
      onChangeCursorPosition={() => undefined}
      onAddPasteMapping={() => 1}
      onAddImagePasteMapping={() => 1}
      disabled={disabled}
    />
  );
}

describe('InputArea', () => {
  it('renders the normal prompt in blue with a neutral border', () => {
    const html = renderInput('explain this file');

    expect(html).toContain('data-border-color="gray"');
    expect(html).toContain('data-color="blue"');
    expect(html).toContain('&gt; ');
  });

  it('renders bang input as an amber user shell prompt', () => {
    const html = renderInput('  ! pwd');

    expect(html).toContain('data-border-color="yellow"');
    expect(html).toContain('data-color="yellow"');
    expect(html).toContain('$ ');
  });

  it('removes input focus when the history viewer disables the composer', () => {
    expect(renderInput('kept draft', true)).toContain('data-focus="false"');
  });
});
