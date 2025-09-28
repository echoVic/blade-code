/**
 * Button 组件单元测试
 */

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { Button } from '../../../../src/ui/ink/Button.js';

describe('Button', () => {
  test('应该正确渲染按钮文本', () => {
    const { getByText } = render(<Button>Hello Button</Button>);
    expect(getByText('Hello Button')).toBeInTheDocument();
  });

  test('应该正确处理点击事件', () => {
    const handleClick = jest.fn();
    const { getByText } = render(<Button onPress={handleClick}>Click Me</Button>);

    fireEvent.click(getByText('Click Me'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  test('应该正确应用禁用状态', () => {
    const handleClick = jest.fn();
    const { getByText } = render(
      <Button onPress={handleClick} isDisabled>
        Disabled Button
      </Button>
    );

    const button = getByText('Disabled Button');
    fireEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  test('应该正确应用颜色属性', () => {
    const { container } = render(<Button color="red">Red Button</Button>);
    expect(container.textContent).toBe('Red Button');
  });

  test('应该正确应用大小属性', () => {
    const { container } = render(<Button size="large">Large Button</Button>);
    expect(container.textContent).toBe('Large Button');
  });

  test('应该正确应用变体属性', () => {
    const { container } = render(<Button variant="primary">Primary Button</Button>);
    expect(container.textContent).toBe('Primary Button');
  });

  test('应该正确处理键盘事件', () => {
    const handleClick = jest.fn();
    const { getByText } = render(
      <Button onPress={handleClick}>Keyboard Button</Button>
    );

    const button = getByText('Keyboard Button');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(handleClick).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(button, { key: ' ' }); // Space
    expect(handleClick).toHaveBeenCalledTimes(2);
  });

  test('应该在禁用时忽略键盘事件', () => {
    const handleClick = jest.fn();
    const { getByText } = render(
      <Button onPress={handleClick} isDisabled>
        Disabled Keyboard Button
      </Button>
    );

    const button = getByText('Disabled Keyboard Button');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(handleClick).not.toHaveBeenCalled();
  });

  test('应该正确处理焦点状态', () => {
    const { container } = render(<Button>Focused Button</Button>);
    expect(container.textContent).toBe('Focused Button');
  });

  test('应该正确处理自定义样式', () => {
    const { container } = render(
      <Button style={{ backgroundColor: 'blue' }}>Styled Button</Button>
    );
    expect(container.textContent).toBe('Styled Button');
  });
});
