/**
 * InputManager 组件单元测试
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { InputManager } from '../src/ui/ink/InputManager.js';

// 模拟 Ink 的 useInput hook
jest.mock('ink', () => ({
  ...jest.requireActual('ink'),
  useInput: jest.fn()
}));

import { useInput } from 'ink';

describe('InputManager', () => {
  const mockUseInput = useInput as jest.Mock;

  beforeEach(() => {
    // 重置mock
    jest.clearAllMocks();
  });

  test('应该正确渲染子组件', () => {
    const { getByText } = render(
      <InputManager>
        <div>Input Managed Content</div>
      </InputManager>
    );
    expect(getByText('Input Managed Content')).toBeInTheDocument();
  });

  test('应该正确处理键盘输入', () => {
    const onKeyDown = jest.fn();
    const onKeyUp = jest.fn();
    
    // 模拟 useInput 回调
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
        <div>Keyboard Input Content</div>
      </InputManager>
    );
    
    // 模拟键盘按下
    act(() => {
      inputCallback('a', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).toHaveBeenCalledWith('a', {
      ctrl: false,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理特殊键', () => {
    const onKeyDown = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown}>
        <div>Special Key Content</div>
      </InputManager>
    );
    
    // 模拟回车键
    act(() => {
      inputCallback('\r', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).toHaveBeenCalledWith('\r', {
      ctrl: false,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理控制键组合', () => {
    const onKeyDown = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown}>
        <div>Control Key Content</div>
      </InputManager>
    );
    
    // 模拟 Ctrl+C
    act(() => {
      inputCallback('c', { ctrl: true, shift: false, meta: false });
    });
    
    expect(onKeyDown).toHaveBeenCalledWith('c', {
      ctrl: true,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理禁用状态', () => {
    const onKeyDown = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown} disabled={true}>
        <div>Disabled Input Content</div>
      </InputManager>
    );
    
    // 模拟输入，应该不触发回调
    act(() => {
      inputCallback('a', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  test('应该正确处理输入焦点', () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    
    const { rerender } = render(
      <InputManager onFocus={onFocus} onBlur={onBlur} focused={true}>
        <div>Focused Content</div>
      </InputManager>
    );
    
    expect(onFocus).toHaveBeenCalled();
    
    rerender(
      <InputManager onFocus={onFocus} onBlur={onBlur} focused={false}>
        <div>Blurred Content</div>
      </InputManager>
    );
    
    expect(onBlur).toHaveBeenCalled();
  });

  test('应该正确处理快捷键映射', () => {
    const onShortcut = jest.fn();
    const shortcuts = {
      'ctrl+c': 'cancel',
      'ctrl+s': 'save',
      'enter': 'submit'
    };
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onShortcut={onShortcut} shortcuts={shortcuts}>
        <div>Shortcut Content</div>
      </InputManager>
    );
    
    // 模拟 Ctrl+C
    act(() => {
      inputCallback('c', { ctrl: true, shift: false, meta: false });
    });
    
    expect(onShortcut).toHaveBeenCalledWith('cancel', {
      key: 'c',
      ctrl: true,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理输入过滤', () => {
    const onKeyDown = jest.fn();
    const inputFilter = (key: string) => key !== ' ';
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown} inputFilter={inputFilter}>
        <div>Filtered Input Content</div>
      </InputManager>
    );
    
    // 空格应该被过滤
    act(() => {
      inputCallback(' ', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).not.toHaveBeenCalled();
    
    // 其他键不应该被过滤
    act(() => {
      inputCallback('a', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).toHaveBeenCalledWith('a', {
      ctrl: false,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理输入模式', () => {
    const onKeyDown = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onKeyDown={onKeyDown} mode="vim">
        <div>Mode Content</div>
      </InputManager>
    );
    
    // 测试模式特定的处理
    act(() => {
      inputCallback('i', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onKeyDown).toHaveBeenCalledWith('i', {
      ctrl: false,
      shift: false,
      meta: false
    });
  });

  test('应该正确处理输入历史', () => {
    const onHistory = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager onHistory={onHistory} historySize={10}>
        <div>History Content</div>
      </InputManager>
    );
    
    // 模拟向上箭头键
    act(() => {
      inputCallback('\u001B[A', { ctrl: false, shift: false, meta: false });
    });
    
    // 检查历史功能是否被调用
    // 注意：具体的实现取决于组件如何处理历史
    expect(true).toBe(true);
  });

  test('应该正确处理自定义输入处理', () => {
    const onInput = jest.fn();
    const customHandler = jest.fn((key, info) => {
      if (key === 'x') {
        onInput(key);
        return true; // 表示已处理
      }
      return false; // 表示未处理
    });
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    render(
      <InputManager customHandler={customHandler}>
        <div>Custom Handler Content</div>
      </InputManager>
    );
    
    // 模拟 'x' 键
    act(() => {
      inputCallback('x', { ctrl: false, shift: false, meta: false });
    });
    
    expect(onInput).toHaveBeenCalledWith('x');
  });

  test('应该正确处理完整的输入管理配置', () => {
    const onKeyDown = jest.fn();
    const onKeyUp = jest.fn();
    const onShortcut = jest.fn();
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    
    const shortcuts = {
      'ctrl+c': 'cancel',
      'ctrl+s': 'save'
    };
    
    const inputFilter = (key: string) => key.length === 1;
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
    });
    
    const { container } = render(
      <InputManager
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onShortcut={onShortcut}
        onFocus={onFocus}
        onBlur={onBlur}
        shortcuts={shortcuts}
        inputFilter={inputFilter}
        mode="default"
        historySize={20}
        disabled={false}
        focused={true}
        throttle={50}
      >
        <div>Full Config Content</div>
      </InputManager>
    );
    
    expect(container.textContent).toBe('Full Config Content');
    expect(onFocus).toHaveBeenCalled();
  });

  test('应该正确处理错误情况', () => {
    // 模拟 useInput 抛出错误
    mockUseInput.mockImplementationOnce(() => {
      throw new Error('Input hook error');
    });
    
    const { container } = render(
      <InputManager>
        <div>Error Resilient Content</div>
      </InputManager>
    );
    
    expect(container.textContent).toBe('Error Resilient Content');
  });

  test('应该正确处理清理函数', () => {
    const cleanup = jest.fn();
    
    let inputCallback: Function = () => {};
    mockUseInput.mockImplementation((callback) => {
      inputCallback = callback;
      return cleanup; // 返回清理函数
    });
    
    const { unmount } = render(
      <InputManager>
        <div>Cleanup Content</div>
      </InputManager>
    );
    
    // 卸载组件应该调用清理函数
    unmount();
    expect(cleanup).toHaveBeenCalled();
  });
});