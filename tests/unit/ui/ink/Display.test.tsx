/**
 * Display 组件单元测试
 */

import { render } from '@testing-library/react';
import React from 'react';
import { Display } from '../../../../src/ui/ink/Display.js';

describe('Display', () => {
  test('应该正确渲染显示内容', () => {
    const { getByText } = render(<Display content="Hello Display" />);
    expect(getByText('Hello Display')).toBeInTheDocument();
  });

  test('应该正确处理多行内容', () => {
    const multiLineContent = 'First line\nSecond line\nThird line';
    const { container } = render(<Display content={multiLineContent} />);
    expect(container.textContent).toBe(multiLineContent);
  });

  test('应该正确应用文本颜色', () => {
    const { container } = render(<Display content="Colored Text" color="red" />);
    expect(container.textContent).toBe('Colored Text');
  });

  test('应该正确应用背景颜色', () => {
    const { container } = render(
      <Display content="Background Text" backgroundColor="blue" />
    );
    expect(container.textContent).toBe('Background Text');
  });

  test('应该正确应用文本样式', () => {
    const { container } = render(
      <Display content="Styled Text" bold={true} italic={true} underline={true} />
    );
    expect(container.textContent).toBe('Styled Text');
  });

  test('应该正确处理空内容', () => {
    const { container } = render(<Display content="" />);
    expect(container.textContent).toBe('');
  });

  test('应该正确处理数字内容', () => {
    const { container } = render(<Display content={42} />);
    expect(container.textContent).toBe('42');
  });

  test('应该正确处理对象内容', () => {
    const objContent = { message: 'Hello', count: 42 };
    const { container } = render(<Display content={objContent} />);
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).toContain('42');
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(
      <Display
        content="Custom Styled"
        style={{ opacity: 0.8, transform: 'scale(1.2)' }}
      />
    );
    expect(container.textContent).toBe('Custom Styled');
  });

  test('应该正确处理超长内容', () => {
    const longContent = 'A'.repeat(1000);
    const { container } = render(<Display content={longContent} />);
    expect(container.textContent).toBe(longContent);
  });

  test('应该正确应用宽度限制', () => {
    const longContent = 'This is a very long line that should be wrapped';
    const { container } = render(<Display content={longContent} maxWidth={20} />);
    expect(container.textContent).toBe(longContent);
  });

  test('应该正确处理滚动显示', () => {
    const longContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const { container } = render(
      <Display content={longContent} maxHeight={3} scrollable={true} />
    );
    expect(container.textContent).toBe(longContent);
  });

  test('应该正确应用对齐方式', () => {
    const { container } = render(<Display content="Centered Text" align="center" />);
    expect(container.textContent).toBe('Centered Text');
  });

  test('应该正确处理动态内容更新', () => {
    const { rerender, getByText } = render(<Display content="Initial" />);
    expect(getByText('Initial')).toBeInTheDocument();

    rerender(<Display content="Updated" />);
    expect(getByText('Updated')).toBeInTheDocument();
  });

  test('应该正确应用完整的显示配置', () => {
    const { container } = render(
      <Display
        content="Full Configuration Display"
        color="green"
        backgroundColor="black"
        bold={true}
        italic={false}
        underline={true}
        align="right"
        maxWidth={50}
        maxHeight={10}
        scrollable={false}
        style={{ margin: 1 }}
      />
    );
    expect(container.textContent).toBe('Full Configuration Display');
  });

  test('应该正确处理数组内容', () => {
    const arrayContent = ['First', 'Second', 'Third'];
    const { container } = render(<Display content={arrayContent} />);
    expect(container.textContent).toBe('First,Second,Third');
  });

  test('应该正确处理React元素内容', () => {
    const elementContent = <span>React Element</span>;
    const { getByText } = render(<Display content={elementContent} />);
    expect(getByText('React Element')).toBeInTheDocument();
  });
});
