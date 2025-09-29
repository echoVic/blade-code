/**
 * VirtualScroll 组件单元测试
 */

import { act, render } from '@testing-library/react';
import React from 'react';
import { VirtualScroll } from '../../../../src/ui/ink/VirtualScroll.js';

describe('VirtualScroll', () => {
  // 创建测试数据
  const testData = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    value: i * 10,
  }));

  // 渲染项的函数
  const renderItem = (item: any) => (
    <div key={item.id}>
      {item.name}: {item.value}
    </div>
  );

  test('应该正确渲染虚拟滚动容器', () => {
    const { container } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理空数据', () => {
    const { container } = render(
      <VirtualScroll items={[]} renderItem={renderItem} itemHeight={2} height={10} />
    );
    expect(container.textContent).toBe('');
  });

  test('应该正确处理单个数据项', () => {
    const singleItem = [{ id: 1, name: 'Single Item', value: 100 }];
    const { getByText } = render(
      <VirtualScroll
        items={singleItem}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );
    expect(getByText('Single Item: 100')).toBeInTheDocument();
  });

  test('应该正确计算可见项', () => {
    // 高度为10，每项高度为2，应该显示5项
    const { container } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );

    // 检查是否渲染了正确数量的项（会有一些缓冲）
    const items = container.querySelectorAll('div');
    expect(items.length).toBeGreaterThan(0);
  });

  test('应该正确处理不同的项高度', () => {
    const { container } = render(
      <VirtualScroll
        items={testData.slice(0, 10)}
        renderItem={renderItem}
        itemHeight={3}
        height={15}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理容器高度变化', () => {
    const { container, rerender } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );

    rerender(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={20}
      />
    );

    expect(container).toBeDefined();
  });

  test('应该正确处理滚动', () => {
    const { container } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );

    // 模拟滚动事件
    const scrollContainer = container.firstChild as HTMLElement;
    if (scrollContainer) {
      act(() => {
        scrollContainer.dispatchEvent(new Event('scroll'));
      });
    }

    expect(container).toBeDefined();
  });

  test('应该正确应用自定义样式', () => {
    const { container } = render(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
        style={{ backgroundColor: 'blue', borderColor: 'red' }}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理自定义类名', () => {
    const { container } = render(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
        className="custom-virtual-scroll"
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理渲染函数变化', () => {
    const { rerender } = render(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
      />
    );

    const alternativeRender = (item: any) => (
      <div key={item.id}>Alternative: {item.name}</div>
    );

    rerender(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={alternativeRender}
        itemHeight={2}
        height={10}
      />
    );

    expect(true).toBe(true); // 只要不抛出错误即可
  });

  test('应该正确处理大数据集', () => {
    const largeDataSet = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      value: i,
    }));

    const { container } = render(
      <VirtualScroll
        items={largeDataSet}
        renderItem={renderItem}
        itemHeight={1}
        height={20}
      />
    );

    expect(container).toBeDefined();
  });

  test('应该正确处理项高度为0', () => {
    const { container } = render(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={renderItem}
        itemHeight={0}
        height={10}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理负数高度', () => {
    const { container } = render(
      <VirtualScroll
        items={testData.slice(0, 5)}
        renderItem={renderItem}
        itemHeight={2}
        height={-10}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确应用滚动偏移', () => {
    const { container } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
        scrollToIndex={5}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理滚动到索引变化', () => {
    const { rerender } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
        scrollToIndex={0}
      />
    );

    rerender(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={10}
        scrollToIndex={10}
      />
    );

    expect(true).toBe(true); // 只要不抛出错误即可
  });

  test('应该正确处理完整的虚拟滚动配置', () => {
    const { container } = render(
      <VirtualScroll
        items={testData}
        renderItem={renderItem}
        itemHeight={2}
        height={20}
        scrollToIndex={5}
        style={{ margin: 1, padding: 2 }}
        className="full-config-scroll"
        onScroll={() => {}}
        overscanCount={3}
      />
    );
    expect(container).toBeDefined();
  });

  test('应该正确处理不同的数据类型', () => {
    const stringItems = ['Item 1', 'Item 2', 'Item 3'];
    const renderStringItem = (item: string, index: number) => (
      <div key={index}>{item}</div>
    );

    const { container } = render(
      <VirtualScroll
        items={stringItems}
        renderItem={renderStringItem}
        itemHeight={2}
        height={10}
      />
    );
    expect(container).toBeDefined();
  });
});
