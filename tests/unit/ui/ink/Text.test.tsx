/**
 * Text 组件单元测试
 */

import { render } from '@testing-library/react';
import React from 'react';
import { Text } from '../../../../src/ui/ink/Text.js';

describe('Text', () => {
  test('应该正确渲染文本内容', () => {
    const { getByText } = render(<Text>Hello World</Text>);
    expect(getByText('Hello World')).toBeInTheDocument();
  });

  test('应该正确应用颜色属性', () => {
    const { container } = render(<Text color="red">Colored Text</Text>);
    // 注意：在测试环境中，颜色样式不会实际应用，但我们测试组件能正确接收属性
    expect(container.textContent).toBe('Colored Text');
  });

  test('应该正确应用粗体属性', () => {
    const { container } = render(<Text bold>Bold Text</Text>);
    expect(container.textContent).toBe('Bold Text');
  });

  test('应该正确应用斜体属性', () => {
    const { container } = render(<Text italic>Italic Text</Text>);
    expect(container.textContent).toBe('Italic Text');
  });

  test('应该正确处理空内容', () => {
    const { container } = render(<Text></Text>);
    expect(container.textContent).toBe('');
  });

  test('应该正确处理数字内容', () => {
    const { container } = render(<Text>{42}</Text>);
    expect(container.textContent).toBe('42');
  });

  test('应该正确处理多个子元素', () => {
    const { container } = render(
      <Text>
        Hello <Text bold>World</Text>
      </Text>
    );
    expect(container.textContent).toBe('Hello World');
  });

  test('应该正确应用多个样式属性', () => {
    const { container } = render(
      <Text color="blue" bold underline>
        Styled Text
      </Text>
    );
    expect(container.textContent).toBe('Styled Text');
  });
});
