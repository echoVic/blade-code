/**
 * Layout 组件单元测试
 */

import React from 'react';
import { render } from '@testing-library/react';
import { Layout } from '../src/ui/ink/Layout.js';

describe('Layout', () => {
  test('应该正确渲染默认布局', () => {
    const { container } = render(
      <Layout>
        <div>Layout Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Layout Content');
  });

  test('应该正确应用布局方向', () => {
    const { container } = render(
      <Layout direction="vertical">
        <div>Vertical Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Vertical Content');
  });

  test('应该正确应用间距属性', () => {
    const { container } = render(
      <Layout gap={2} padding={1}>
        <div>Spaced Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Spaced Content');
  });

  test('应该正确处理水平布局', () => {
    const { container } = render(
      <Layout direction="horizontal" gap={1}>
        <div>First</div>
        <div>Second</div>
      </Layout>
    );
    expect(container.textContent).toBe('FirstSecond');
  });

  test('应该正确应用对齐属性', () => {
    const { container } = render(
      <Layout alignItems="center" justifyContent="center">
        <div>Aligned Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Aligned Content');
  });

  test('应该正确处理嵌套布局', () => {
    const { container } = render(
      <Layout direction="vertical">
        <Layout direction="horizontal">
          <div>Top Left</div>
          <div>Top Right</div>
        </Layout>
        <Layout direction="horizontal">
          <div>Bottom Left</div>
          <div>Bottom Right</div>
        </Layout>
      </Layout>
    );
    expect(container.textContent).toBe('Top LeftTop RightBottom LeftBottom Right');
  });

  test('应该正确应用容器大小', () => {
    const { container } = render(
      <Layout width={80} height={24}>
        <div>Sized Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Sized Content');
  });

  test('应该正确处理响应式布局', () => {
    const { container } = render(
      <Layout responsive={true}>
        <div>Responsive Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Responsive Content');
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(
      <Layout style={{ backgroundColor: 'blue', borderColor: 'red' }}>
        <div>Styled Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Styled Content');
  });

  test('应该正确处理多个子元素', () => {
    const { container } = render(
      <Layout gap={1}>
        <div>First Element</div>
        <div>Second Element</div>
        <div>Third Element</div>
      </Layout>
    );
    expect(container.textContent).toBe('First ElementSecond ElementThird Element');
  });

  test('应该正确应用边框样式', () => {
    const { container } = render(
      <Layout border="single" borderColor="green">
        <div>Bordered Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Bordered Content');
  });

  test('应该正确处理条件渲染的子元素', () => {
    const showSecond = false;
    const { container } = render(
      <Layout gap={1}>
        <div>First</div>
        {showSecond && <div>Second</div>}
        <div>Third</div>
      </Layout>
    );
    expect(container.textContent).toBe('FirstThird');
  });

  test('应该正确应用完整的布局配置', () => {
    const { container } = render(
      <Layout
        direction="vertical"
        gap={2}
        padding={1}
        alignItems="stretch"
        justifyContent="flex-start"
        width={100}
        height={50}
        border="round"
        borderColor="blue"
        backgroundColor="black"
        color="white"
        responsive={true}
      >
        <div>Full Config Content</div>
      </Layout>
    );
    expect(container.textContent).toBe('Full Config Content');
  });

  test('应该正确处理空布局', () => {
    const { container } = render(<Layout></Layout>);
    expect(container.textContent).toBe('');
  });

  test('应该正确应用标题属性', () => {
    const { getByText } = render(
      <Layout title="Layout Title">
        <div>Content</div>
      </Layout>
    );
    expect(getByText('Layout Title')).toBeInTheDocument();
    expect(getByText('Content')).toBeInTheDocument();
  });
});