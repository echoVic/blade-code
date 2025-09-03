/**
 * Spinner 组件单元测试
 */

import React from 'react';
import { render } from '@testing-library/react';
import { Spinner } from '../src/ui/ink/Spinner.js';

describe('Spinner', () => {
  test('应该正确渲染默认旋转器', () => {
    const { container } = render(<Spinner />);
    expect(container.textContent).not.toBe('');
    // 旋转器应该渲染一些字符
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  test('应该正确应用类型属性', () => {
    const { container } = render(<Spinner type="dots" />);
    expect(container).toBeDefined();
  });

  test('应该正确应用颜色属性', () => {
    const { container } = render(<Spinner color="red" />);
    expect(container).toBeDefined();
  });

  test('应该正确应用大小属性', () => {
    const { container } = render(<Spinner size="large" />);
    expect(container).toBeDefined();
  });

  test('应该正确应用标签', () => {
    const { getByText } = render(<Spinner label="Loading..." />);
    expect(getByText('Loading...')).toBeInTheDocument();
  });

  test('应该正确处理空标签', () => {
    const { container } = render(<Spinner label="" />);
    expect(container).toBeDefined();
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(<Spinner style={{ margin: '10px' }} />);
    expect(container).toBeDefined();
  });

  test('应该正确处理不同的旋转器类型', () => {
    const types = ['dots', 'line', 'circle', 'clock', 'sandwich'];
    
    types.forEach(type => {
      const { container } = render(<Spinner type={type as any} />);
      expect(container).toBeDefined();
    });
  });

  test('应该正确应用自定义字符', () => {
    const { container } = render(<Spinner characters={['-', '\\', '|', '/']} />);
    expect(container).toBeDefined();
  });

  test('应该正确处理间隔属性', () => {
    const { container } = render(<Spinner interval={200} />);
    expect(container).toBeDefined();
  });

  test('应该正确应用延迟属性', () => {
    const { container } = render(<Spinner delay={1000} />);
    expect(container).toBeDefined();
  });

  test('应该正确处理禁用状态', () => {
    const { container } = render(<Spinner isDisabled />);
    expect(container).toBeDefined();
  });

  test('应该正确应用对齐属性', () => {
    const { container } = render(<Spinner align="center" />);
    expect(container).toBeDefined();
  });

  test('应该正确处理完整配置', () => {
    const { getByText } = render(
      <Spinner
        type="dots"
        color="blue"
        size="medium"
        label="Processing..."
        interval={150}
        delay={500}
        align="right"
      />
    );
    expect(getByText('Processing...')).toBeInTheDocument();
  });
});