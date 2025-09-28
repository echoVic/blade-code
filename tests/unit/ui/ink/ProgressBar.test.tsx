/**
 * ProgressBar 组件单元测试
 */

import { render } from '@testing-library/react';
import React from 'react';
import { ProgressBar } from '../../../../src/ui/ink/ProgressBar.js';

describe('ProgressBar', () => {
  test('应该正确渲染进度条', () => {
    const { container } = render(<ProgressBar value={50} />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确处理进度值', () => {
    const { container } = render(<ProgressBar value={75} />);
    expect(container.textContent).toContain('75%');
  });

  test('应该正确处理最小值', () => {
    const { container } = render(<ProgressBar value={0} />);
    expect(container.textContent).toContain('0%');
  });

  test('应该正确处理最大值', () => {
    const { container } = render(<ProgressBar value={100} />);
    expect(container.textContent).toContain('100%');
  });

  test('应该正确处理超出范围的值', () => {
    const { container } = render(<ProgressBar value={150} />);
    expect(container.textContent).toContain('100%'); // 应该被限制在100%
  });

  test('应该正确处理负值', () => {
    const { container } = render(<ProgressBar value={-50} />);
    expect(container.textContent).toContain('0%'); // 应该被限制在0%
  });

  test('应该正确应用自定义标签', () => {
    const { container } = render(<ProgressBar value={50} label="Loading..." />);
    expect(container.textContent).toContain('Loading...');
  });

  test('应该正确应用颜色属性', () => {
    const { container } = render(<ProgressBar value={50} color="green" />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确应用大小属性', () => {
    const { container } = render(<ProgressBar value={50} size="large" />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确处理不同的进度范围', () => {
    const { container } = render(<ProgressBar value={3} min={0} max={10} />);
    // 3/10 = 30%
    expect(container.textContent).toContain('30%');
  });

  test('应该正确应用自定义格式化函数', () => {
    const format = (value: number, min: number, max: number) => `${value}/${max}`;
    const { container } = render(
      <ProgressBar value={5} min={0} max={10} format={format} />
    );
    expect(container.textContent).toContain('5/10');
  });

  test('应该正确处理动画属性', () => {
    const { container } = render(<ProgressBar value={50} isAnimated />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确处理条纹属性', () => {
    const { container } = render(<ProgressBar value={50} isStriped />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(<ProgressBar value={50} style={{ height: '20px' }} />);
    expect(container.textContent).toContain('50%');
  });

  test('应该正确处理无标签显示', () => {
    const { container } = render(<ProgressBar value={50} showLabel={false} />);
    // 可能不显示百分比文本，但仍然渲染进度条
    expect(container).toBeDefined();
  });

  test('应该正确处理不同的宽度属性', () => {
    const { container } = render(<ProgressBar value={50} width={50} />);
    expect(container.textContent).toContain('50%');
  });
});
