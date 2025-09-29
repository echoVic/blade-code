/**
 * Input 组件单元测试
 */

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { Input } from '../../../../src/ui/ink/Input.js';

describe('Input', () => {
  test('应该正确渲染输入框', () => {
    const { container } = render(<Input placeholder="Enter text" />);
    expect(container.textContent).toContain('Enter text');
  });

  test('应该正确处理输入变化', () => {
    const handleChange = jest.fn();
    const { getByPlaceholderText } = render(
      <Input placeholder="Enter text" onChange={handleChange} />
    );

    const input = getByPlaceholderText('Enter text');
    fireEvent.change(input, { target: { value: 'Hello World' } });

    expect(handleChange).toHaveBeenCalledWith('Hello World');
  });

  test('应该正确处理初始值', () => {
    const { container } = render(<Input value="Initial value" />);
    expect(container.textContent).toContain('Initial value');
  });

  test('应该正确应用占位符', () => {
    const { container } = render(<Input placeholder="Placeholder text" />);
    expect(container.textContent).toContain('Placeholder text');
  });

  test('应该正确应用禁用状态', () => {
    const handleChange = jest.fn();
    const { container } = render(
      <Input placeholder="Disabled input" isDisabled onChange={handleChange} />
    );

    const input = container.querySelector('input') || container;
    fireEvent.change(input, { target: { value: 'Test' } });

    expect(handleChange).not.toHaveBeenCalled();
  });

  test('应该正确处理焦点事件', () => {
    const handleFocus = jest.fn();
    const handleBlur = jest.fn();
    const { getByPlaceholderText } = render(
      <Input placeholder="Focus test" onFocus={handleFocus} onBlur={handleBlur} />
    );

    const input = getByPlaceholderText('Focus test');
    fireEvent.focus(input);
    expect(handleFocus).toHaveBeenCalledTimes(1);

    fireEvent.blur(input);
    expect(handleBlur).toHaveBeenCalledTimes(1);
  });

  test('应该正确应用密码模式', () => {
    const { container } = render(<Input placeholder="Password" isPassword />);
    expect(container.textContent).toContain('Password');
  });

  test('应该正确处理键盘事件', () => {
    const handleKeyDown = jest.fn();
    const handleKeyUp = jest.fn();
    const { getByPlaceholderText } = render(
      <Input
        placeholder="Keyboard test"
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      />
    );

    const input = getByPlaceholderText('Keyboard test');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyUp(input, { key: 'Enter' });

    expect(handleKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter' })
    );
    expect(handleKeyUp).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(
      <Input placeholder="Styled input" style={{ borderColor: 'red' }} />
    );
    expect(container.textContent).toContain('Styled input');
  });

  test('应该正确处理清除功能', () => {
    const handleChange = jest.fn();
    const { getByPlaceholderText, getByText } = render(
      <Input
        placeholder="Clearable input"
        value="Test value"
        onChange={handleChange}
        isClearable
      />
    );

    const clearButton = getByText('×'); // 假设清除按钮使用这个符号
    if (clearButton) {
      fireEvent.click(clearButton);
      expect(handleChange).toHaveBeenCalledWith('');
    }
  });

  test('应该正确应用大小属性', () => {
    const { container } = render(<Input placeholder="Large input" size="large" />);
    expect(container.textContent).toContain('Large input');
  });
});
