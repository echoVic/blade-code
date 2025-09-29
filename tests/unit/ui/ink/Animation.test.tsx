/**
 * Animation 组件单元测试
 */

import { act, render } from '@testing-library/react';
import React from 'react';
import { Animation } from '../../../../src/ui/ink/Animation.js';

// 模拟 setTimeout 和 clearTimeout 以便控制时间
jest.useFakeTimers();

describe('Animation', () => {
  test('应该正确渲染初始帧', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const { getByText } = render(<Animation frames={frames} interval={1000} />);
    expect(getByText('Frame 1')).toBeInTheDocument();
  });

  test('应该正确处理动画帧切换', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const { getByText } = render(<Animation frames={frames} interval={1000} />);

    // 初始帧
    expect(getByText('Frame 1')).toBeInTheDocument();

    // 推进时间到下一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(getByText('Frame 2')).toBeInTheDocument();
  });

  test('应该正确处理循环播放', () => {
    const frames = ['Frame 1', 'Frame 2'];
    const { getByText } = render(
      <Animation frames={frames} interval={1000} loop={true} />
    );

    // 初始帧
    expect(getByText('Frame 1')).toBeInTheDocument();

    // 推进到第二帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Frame 2')).toBeInTheDocument();

    // 推进到循环回到第一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Frame 1')).toBeInTheDocument();
  });

  test('应该正确处理单次播放', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const { getByText } = render(
      <Animation frames={frames} interval={1000} loop={false} />
    );

    // 初始帧
    expect(getByText('Frame 1')).toBeInTheDocument();

    // 推进到最后一个帧
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(getByText('Frame 3')).toBeInTheDocument();

    // 继续推进时间，应该保持在最后一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Frame 3')).toBeInTheDocument();
  });

  test('应该正确处理不同的时间间隔', () => {
    const frames = ['Frame 1', 'Frame 2'];
    const { getByText } = render(<Animation frames={frames} interval={500} />);

    expect(getByText('Frame 1')).toBeInTheDocument();

    // 使用较短的时间间隔
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(getByText('Frame 2')).toBeInTheDocument();
  });

  test('应该正确处理自定义起始帧', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const { getByText } = render(
      <Animation frames={frames} interval={1000} initialFrame={1} />
    );
    expect(getByText('Frame 2')).toBeInTheDocument();
  });

  test('应该正确处理空帧数组', () => {
    const { container } = render(<Animation frames={[]} interval={1000} />);
    expect(container.textContent).toBe('');
  });

  test('应该正确处理单帧动画', () => {
    const frames = ['Single Frame'];
    const { getByText } = render(<Animation frames={frames} interval={1000} />);
    expect(getByText('Single Frame')).toBeInTheDocument();

    // 推进时间，应该保持在同一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Single Frame')).toBeInTheDocument();
  });

  test('应该正确处理自定义渲染函数', () => {
    const frames = [1, 2, 3];
    const renderFrame = (frame: number) => `Custom Frame ${frame}`;
    const { getByText } = render(
      <Animation frames={frames} interval={1000} renderFrame={renderFrame} />
    );
    expect(getByText('Custom Frame 1')).toBeInTheDocument();
  });

  test('应该正确处理暂停和恢复', () => {
    const frames = ['Frame 1', 'Frame 2'];
    const { getByText, rerender } = render(
      <Animation frames={frames} interval={1000} paused={false} />
    );

    expect(getByText('Frame 1')).toBeInTheDocument();

    // 暂停动画
    rerender(<Animation frames={frames} interval={1000} paused={true} />);

    // 推进时间，应该保持在同一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Frame 1')).toBeInTheDocument();

    // 恢复动画
    rerender(<Animation frames={frames} interval={1000} paused={false} />);

    // 推进时间，应该切换到下一帧
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('Frame 2')).toBeInTheDocument();
  });

  test('应该正确处理动画完成回调', () => {
    const onComplete = jest.fn();
    const frames = ['Frame 1', 'Frame 2'];
    render(
      <Animation frames={frames} interval={1000} loop={false} onComplete={onComplete} />
    );

    // 推进到动画完成
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    // 再推进一次完成动画
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test('应该正确处理方向属性', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const { getByText } = render(
      <Animation frames={frames} interval={1000} direction="reverse" />
    );
    expect(getByText('Frame 1')).toBeInTheDocument();
  });

  test('应该正确销毁定时器', () => {
    const frames = ['Frame 1', 'Frame 2'];
    const { unmount } = render(<Animation frames={frames} interval={1000} />);

    // 推进时间
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    // 卸载组件
    unmount();

    // 确保定时器被清理
    act(() => {
      jest.advanceTimersByTime(1000);
    });
  });

  test('应该正确应用完整的动画配置', () => {
    const frames = ['Frame 1', 'Frame 2', 'Frame 3'];
    const renderFrame = (frame: string) => (
      <span style={{ color: 'red' }}>{frame}</span>
    );
    const onComplete = jest.fn();

    const { getByText } = render(
      <Animation
        frames={frames}
        interval={500}
        loop={true}
        initialFrame={0}
        paused={false}
        direction="normal"
        renderFrame={renderFrame}
        onComplete={onComplete}
        style={{ margin: 1 }}
      />
    );
    expect(getByText('Frame 1')).toBeInTheDocument();
  });
});
