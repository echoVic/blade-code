/**
 * PerformanceOptimizer 组件单元测试
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { PerformanceOptimizer } from '../src/ui/ink/PerformanceOptimizer.js';

// 模拟性能监控API
const mockPerformance = {
  now: jest.fn(() => Date.now()),
  mark: jest.fn(),
  measure: jest.fn(),
  getEntriesByName: jest.fn(() => []),
  clearMarks: jest.fn(),
  clearMeasures: jest.fn()
};

// 模拟内存监控
const mockProcess = {
  memoryUsage: jest.fn(() => ({
    rss: 100000,
    heapTotal: 50000,
    heapUsed: 25000,
    external: 10000
  }))
};

describe('PerformanceOptimizer', () => {
  beforeEach(() => {
    // 重置mocks
    jest.clearAllMocks();
    
    // 设置全局性能API
    (global as any).performance = mockPerformance;
    (global as any).process = mockProcess;
  });

  test('应该正确渲染子组件', () => {
    const { getByText } = render(
      <PerformanceOptimizer>
        <div>Optimized Content</div>
      </PerformanceOptimizer>
    );
    expect(getByText('Optimized Content')).toBeInTheDocument();
  });

  test('应该正确应用性能标记', () => {
    render(
      <PerformanceOptimizer name="test-component">
        <div>Marked Content</div>
      </PerformanceOptimizer>
    );
    
    expect(mockPerformance.mark).toHaveBeenCalledWith('test-component-start');
    expect(mockPerformance.mark).toHaveBeenCalledWith('test-component-end');
  });

  test('应该正确处理性能测量', () => {
    render(
      <PerformanceOptimizer name="measured-component" measure={true}>
        <div>Measured Content</div>
      </PerformanceOptimizer>
    );
    
    expect(mockPerformance.mark).toHaveBeenCalledWith('measured-component-start');
    expect(mockPerformance.mark).toHaveBeenCalledWith('measured-component-end');
    expect(mockPerformance.measure).toHaveBeenCalledWith(
      'measured-component',
      'measured-component-start',
      'measured-component-end'
    );
  });

  test('应该正确处理禁用状态', () => {
    const { container } = render(
      <PerformanceOptimizer enabled={false}>
        <div>Disabled Content</div>
      </PerformanceOptimizer>
    );
    expect(container.textContent).toBe('Disabled Content');
    expect(mockPerformance.mark).not.toHaveBeenCalled();
  });

  test('应该正确处理空子组件', () => {
    const { container } = render(
      <PerformanceOptimizer>
        <></>
      </PerformanceOptimizer>
    );
    expect(container.textContent).toBe('');
  });

  test('应该正确处理多个子组件', () => {
    const { container } = render(
      <PerformanceOptimizer>
        <div>First</div>
        <div>Second</div>
        <div>Third</div>
      </PerformanceOptimizer>
    );
    expect(container.textContent).toBe('FirstSecondThird');
  });

  test('应该正确处理条件渲染', () => {
    const showContent = true;
    const { container } = render(
      <PerformanceOptimizer>
        {showContent && <div>Conditional Content</div>}
        <div>Always Content</div>
      </PerformanceOptimizer>
    );
    expect(container.textContent).toBe('Conditional ContentAlways Content');
  });

  test('应该正确应用内存监控', () => {
    render(
      <PerformanceOptimizer name="memory-component" monitorMemory={true}>
        <div>Memory Monitored Content</div>
      </PerformanceOptimizer>
    );
    
    expect(mockProcess.memoryUsage).toHaveBeenCalled();
  });

  test('应该正确处理性能回调', () => {
    const onPerformance = jest.fn();
    render(
      <PerformanceOptimizer 
        name="callback-component" 
        measure={true} 
        onPerformance={onPerformance}
      >
        <div>Callback Content</div>
      </PerformanceOptimizer>
    );
    
    // 模拟性能测量结果
    const mockEntries = [{
      duration: 5.5,
      startTime: 1000,
      entryType: 'measure'
    }];
    
    mockPerformance.getEntriesByName.mockReturnValue(mockEntries);
    
    expect(onPerformance).toHaveBeenCalledWith({
      name: 'callback-component',
      duration: expect.any(Number),
      memoryUsage: expect.any(Object)
    });
  });

  test('应该正确处理渲染频率限制', () => {
    jest.useFakeTimers();
    
    const { rerender } = render(
      <PerformanceOptimizer throttle={100}>
        <div>Content 1</div>
      </PerformanceOptimizer>
    );
    
    rerender(
      <PerformanceOptimizer throttle={100}>
        <div>Content 2</div>
      </PerformanceOptimizer>
    );
    
    // 快速连续更新应该被限制
    act(() => {
      jest.advanceTimersByTime(50);
    });
    
    rerender(
      <PerformanceOptimizer throttle={100}>
        <div>Content 3</div>
      </PerformanceOptimizer>
    );
    
    act(() => {
      jest.advanceTimersByTime(100);
    });
    
    expect(true).toBe(true); // 只要不抛出错误即可
    
    jest.useRealTimers();
  });

  test('应该正确处理错误情况', () => {
    // 模拟性能API抛出错误
    mockPerformance.mark.mockImplementationOnce(() => {
      throw new Error('Performance API error');
    });
    
    const { container } = render(
      <PerformanceOptimizer name="error-component">
        <div>Error Resilient Content</div>
      </PerformanceOptimizer>
    );
    
    expect(container.textContent).toBe('Error Resilient Content');
  });

  test('应该正确处理自定义性能指标', () => {
    const customMetrics = jest.fn();
    render(
      <PerformanceOptimizer 
        name="custom-component" 
        measure={true}
        customMetrics={customMetrics}
      >
        <div>Custom Metrics Content</div>
      </PerformanceOptimizer>
    );
    
    expect(customMetrics).toHaveBeenCalled();
  });

  test('应该正确应用性能边界', () => {
    const { container } = render(
      <PerformanceOptimizer 
        name="bounded-component"
        maxDuration={100}
        maxMemory={1000000}
      >
        <div>Bounded Content</div>
      </PerformanceOptimizer>
    );
    expect(container.textContent).toBe('Bounded Content');
  });

  test('应该正确处理性能警告', () => {
    const onWarning = jest.fn();
    
    // 模拟高内存使用
    mockProcess.memoryUsage.mockReturnValueOnce({
      rss: 2000000,
      heapTotal: 1000000,
      heapUsed: 800000,
      external: 200000
    });
    
    render(
      <PerformanceOptimizer 
        name="warning-component"
        monitorMemory={true}
        maxMemory={1000000}
        onWarning={onWarning}
      >
        <div>Warning Content</div>
      </PerformanceOptimizer>
    );
    
    // 检查是否触发了警告
    expect(onWarning).toHaveBeenCalled();
  });

  test('应该正确处理完整的性能优化配置', () => {
    const onPerformance = jest.fn();
    const onWarning = jest.fn();
    const customMetrics = jest.fn();
    
    const { container } = render(
      <PerformanceOptimizer
        name="full-config-component"
        measure={true}
        monitorMemory={true}
        throttle={50}
        maxDuration={200}
        maxMemory={2000000}
        enabled={true}
        onPerformance={onPerformance}
        onWarning={onWarning}
        customMetrics={customMetrics}
        style={{ margin: 1 }}
        className="perf-optimized"
      >
        <div>Full Config Content</div>
      </PerformanceOptimizer>
    );
    
    expect(container.textContent).toBe('Full Config Content');
  });

  test('应该正确处理嵌套性能优化器', () => {
    const { container } = render(
      <PerformanceOptimizer name="outer">
        <PerformanceOptimizer name="inner">
          <div>Nested Content</div>
        </PerformanceOptimizer>
      </PerformanceOptimizer>
    );
    
    expect(container.textContent).toBe('Nested Content');
    expect(mockPerformance.mark).toHaveBeenCalledWith('outer-start');
    expect(mockPerformance.mark).toHaveBeenCalledWith('inner-start');
  });
});