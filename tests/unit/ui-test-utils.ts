/**
 * UI 测试工具和辅助函数
 */

import React from 'react';
import { expect } from 'vitest';

// 类型定义
export interface UIComponentTestOptions {
  renderOptions?: any;
  mockOptions?: Record<string, any>;
  timeout?: number;
}

export interface UIComponentTestResult {
  container: HTMLElement;
  component: React.ReactElement;
  metrics: {
    renderTime: number;
    memoryUsage: number;
    updateCount: number;
  };
}

// UI测试工具类
export class UIComponentTestUtils {
  /**
   * 创建模拟事件
   */
  static createMockEvent(type: string, data: Record<string, any> = {}): Event {
    const event = new Event(type);
    Object.assign(event, data);
    return event;
  }

  /**
   * 创建模拟键盘事件
   */
  static createKeyboardEvent(
    key: string,
    options: KeyboardEventInit = {}
  ): KeyboardEvent {
    return new KeyboardEvent('keydown', {
      key,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      ...options,
    });
  }

  /**
   * 创建模拟鼠标事件
   */
  static createMouseEvent(type: string, options: MouseEventInit = {}): MouseEvent {
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...options,
    });
  }

  /**
   * 等待组件更新
   */
  static async waitForComponentUpdate(timeout = 1000): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
      if (timeout > 0) {
        setTimeout(resolve, timeout);
      }
    });
  }

  /**
   * 测量组件渲染性能
   */
  static async measureRenderPerformance<T>(
    renderFn: () => T
  ): Promise<{ result: T; renderTime: number; memoryUsage: number }> {
    const startTime = performance.now();
    const startMemory =
      typeof process !== 'undefined' ? process.memoryUsage() : { heapUsed: 0 };

    const result = renderFn();

    const endTime = performance.now();
    const endMemory =
      typeof process !== 'undefined' ? process.memoryUsage() : { heapUsed: 0 };

    return {
      result,
      renderTime: endTime - startTime,
      memoryUsage: endMemory.heapUsed - startMemory.heapUsed,
    };
  }

  /**
   * 创建测试数据生成器
   */
  static createTestDataGenerator<T>(template: T): () => T {
    return () => ({ ...(template as any) });
  }

  /**
   * 模拟用户交互
   */
  static async simulateUserInteraction(
    element: HTMLElement,
    interaction: 'click' | 'hover' | 'focus' | 'blur' | 'keyDown' | 'keyUp',
    data?: any
  ): Promise<void> {
    switch (interaction) {
      case 'click':
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        break;
      case 'hover':
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        break;
      case 'focus':
        element.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        break;
      case 'blur':
        element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        break;
      case 'keyDown':
        element.dispatchEvent(new KeyboardEvent('keydown', data));
        break;
      case 'keyUp':
        element.dispatchEvent(new KeyboardEvent('keyup', data));
        break;
    }

    // 等待事件处理完成
    await this.waitForComponentUpdate(0);
  }

  /**
   * 检查组件属性
   */
  static checkComponentProps<Props>(
    component: React.ReactElement<Props>,
    expectedProps: Partial<Props>
  ): void {
    const actualProps = component.props;
    Object.keys(expectedProps).forEach((key) => {
      expect(actualProps[key]).toEqual(expectedProps[key as keyof Props]);
    });
  }

  /**
   * 创建模拟上下文提供者
   */
  static createMockContextProvider<T>(
    context: React.Context<T>,
    value: T
  ): React.FC<{ children: React.ReactNode }> {
    return ({ children }) => React.createElement(context.Provider, { value }, children);
  }

  /**
   * 测试组件的无障碍性
   */
  static async testAccessibility(
    container: HTMLElement
  ): Promise<{ violations: any[]; passes: any[] }> {
    // 这里可以集成 axe-core 或其他无障碍测试工具
    // 目前返回模拟结果
    return {
      violations: [],
      passes: [],
    };
  }

  /**
   * 比较组件快照
   */
  static compareSnapshot(
    current: string,
    expected: string
  ): { isMatch: boolean; differences: string[] } {
    const isMatch = current === expected;
    const differences: string[] = [];

    if (!isMatch) {
      // 简单的差异比较
      const currentLines = current.split('\n');
      const expectedLines = expected.split('\n');
      const maxLines = Math.max(currentLines.length, expectedLines.length);

      for (let i = 0; i < maxLines; i++) {
        const currentLine = currentLines[i] || '';
        const expectedLine = expectedLines[i] || '';

        if (currentLine !== expectedLine) {
          differences.push(
            `Line ${i + 1}: expected "${expectedLine}", got "${currentLine}"`
          );
        }
      }
    }

    return { isMatch, differences };
  }
}

// 快捷导出常用工具
export const {
  createMockEvent,
  createKeyboardEvent,
  createMouseEvent,
  waitForComponentUpdate,
  measureRenderPerformance,
  createTestDataGenerator,
  simulateUserInteraction,
  checkComponentProps,
  createMockContextProvider,
  testAccessibility,
  compareSnapshot,
} = UIComponentTestUtils;

// UI测试常量
export const UITestConstants = {
  DEFAULT_TIMEOUT: 5000,
  RENDER_TIMEOUT: 1000,
  INTERACTION_TIMEOUT: 500,
  PERFORMANCE_THRESHOLD: 100, // ms
  MEMORY_THRESHOLD: 1000000, // 1MB
};

// 测试数据工厂
export class UITestDataFactory {
  /**
   * 生成测试用户数据
   */
  static createUser(id: number = 1): any {
    return {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`,
      role: 'user',
      avatar: `https://example.com/avatar${id}.jpg`,
    };
  }

  /**
   * 生成测试项目数据
   */
  static createProject(id: number = 1): any {
    return {
      id,
      name: `Project ${id}`,
      description: `Description for project ${id}`,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成测试配置数据
   */
  static createConfig(id: number = 1): any {
    return {
      id,
      name: `Config ${id}`,
      theme: 'default',
      language: 'en',
      notifications: true,
      preferences: {
        autoSave: true,
        showTips: true,
      },
    };
  }

  /**
   * 生成测试错误数据
   */
  static createError(
    message: string = 'Test error',
    code: string = 'TEST_ERROR'
  ): Error {
    const error = new Error(message);
    (error as any).code = code;
    return error;
  }

  /**
   * 生成测试状态数据
   */
  static createState(initial: any = {}): any {
    return {
      loading: false,
      error: null,
      data: null,
      ...initial,
    };
  }
}

export const { createUser, createProject, createConfig, createError, createState } =
  UITestDataFactory;

// 自定义测试匹配器
export const UITestMatchers = {
  /**
   * 检查元素是否可见
   */
  toBeVisible(received: HTMLElement): { pass: boolean; message: () => string } {
    const isHidden =
      received.style.display === 'none' ||
      received.style.visibility === 'hidden' ||
      received.hidden;

    return {
      pass: !isHidden,
      message: () =>
        isHidden
          ? `Expected element to be visible, but it is hidden`
          : `Expected element to be hidden, but it is visible`,
    };
  },

  /**
   * 检查元素是否启用
   */
  toBeEnabled(received: HTMLElement): { pass: boolean; message: () => string } {
    const isDisabled =
      received.hasAttribute('disabled') ||
      received.getAttribute('aria-disabled') === 'true';

    return {
      pass: !isDisabled,
      message: () =>
        isDisabled
          ? `Expected element to be enabled, but it is disabled`
          : `Expected element to be disabled, but it is enabled`,
    };
  },

  /**
   * 检查元素是否有特定类名
   */
  toHaveClass(
    received: HTMLElement,
    className: string
  ): { pass: boolean; message: () => string } {
    const hasClass = received.classList.contains(className);

    return {
      pass: hasClass,
      message: () =>
        hasClass
          ? `Expected element not to have class "${className}"`
          : `Expected element to have class "${className}"`,
    };
  },

  /**
   * 检查元素是否有特定属性
   */
  toHaveAttribute(
    received: HTMLElement,
    name: string,
    value?: string
  ): { pass: boolean; message: () => string } {
    const hasAttribute =
      value !== undefined
        ? received.getAttribute(name) === value
        : received.hasAttribute(name);

    return {
      pass: hasAttribute,
      message: () =>
        hasAttribute
          ? `Expected element not to have attribute "${name}"`
          : `Expected element to have attribute "${name}"`,
    };
  },
};

// 扩展 Vitest 期望
declare module 'vitest' {
  interface Assertion<T = any> {
    toBeVisible(): T;
    toBeEnabled(): T;
    toHaveClass(className: string): T;
    toHaveAttribute(name: string, value?: string): T;
  }
}

// 应用自定义匹配器
expect.extend(UITestMatchers);
