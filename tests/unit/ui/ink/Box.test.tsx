/**
 * Box 组件单元测试
 */

import { render } from '@testing-library/react';
import React from 'react';
import { Box } from '../../../../src/ui/ink/Box.js';

describe('Box', () => {
  test('应该正确渲染子元素', () => {
    const { getByText } = render(
      <Box>
        <span>Box Content</span>
      </Box>
    );
    expect(getByText('Box Content')).toBeInTheDocument();
  });

  test('应该正确应用布局属性', () => {
    const { container } = render(
      <Box flexDirection="column" justifyContent="center" alignItems="center">
        <span>Box Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Box Content');
  });

  test('应该正确应用间距属性', () => {
    const { container } = render(
      <Box margin={2} padding={1}>
        <span>Spaced Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Spaced Content');
  });

  test('应该正确应用宽度和高度', () => {
    const { container } = render(
      <Box width={20} height={10}>
        <span>Sized Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Sized Content');
  });

  test('应该正确应用颜色属性', () => {
    const { container } = render(
      <Box backgroundColor="blue" color="white">
        <span>Colored Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Colored Content');
  });

  test('应该正确应用边框属性', () => {
    const { container } = render(
      <Box borderStyle="round">
        <span>Bordered Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Bordered Content');
  });

  test('应该正确处理嵌套Box', () => {
    const { container } = render(
      <Box flexDirection="column">
        <Box>
          <span>First Box</span>
        </Box>
        <Box>
          <span>Second Box</span>
        </Box>
      </Box>
    );
    expect(container.textContent).toBe('First BoxSecond Box');
  });

  test('应该正确应用显示属性', () => {
    const { container } = render(
      <Box display="flex">
        <span>Flex Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Flex Content');
  });

  test('应该正确应用溢出属性', () => {
    const { container } = render(
      <Box overflow="hidden">
        <span>Overflow Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Overflow Content');
  });

  test('应该正确应用文本对齐', () => {
    const { container } = render(
      <Box textAlign="center">
        <span>Centered Text</span>
      </Box>
    );
    expect(container.textContent).toBe('Centered Text');
  });

  test('应该正确应用自定义样式对象', () => {
    const { container } = render(
      <Box style={{ opacity: 0.5, transform: 'scale(1.1)' }}>
        <span>Styled Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Styled Content');
  });

  test('应该正确处理条件渲染', () => {
    const showContent = true;
    const { container } = render(
      <Box>
        {showContent && <span>Conditional Content</span>}
        <span>Always Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Conditional ContentAlways Content');
  });

  test('应该正确应用响应式属性', () => {
    const { container } = render(
      <Box width={{ xs: 10, sm: 20, md: 30 }}>
        <span>Responsive Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Responsive Content');
  });

  test('应该正确处理空子元素', () => {
    const { container } = render(<Box></Box>);
    expect(container.textContent).toBe('');
  });

  test('应该正确应用完整的布局配置', () => {
    const { container } = render(
      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="stretch"
        margin={1}
        padding={2}
        width="100%"
        height="auto"
        backgroundColor="gray"
        color="black"
        borderStyle="single"
        textAlign="left"
        display="flex"
        overflow="visible"
      >
        <span>Full Config Content</span>
      </Box>
    );
    expect(container.textContent).toBe('Full Config Content');
  });
});
