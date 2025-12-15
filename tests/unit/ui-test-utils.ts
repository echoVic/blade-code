/**
 * UI 测试工具
 * 为 UI 组件测试提供专门的工具和辅助函数
 */

import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';

// Mock React 和相关模块
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    useId: () => 'test-id',
  };
});

// UI 测试相关的辅助函数
export const createMockStore = (initialState = {}) => {
  return {
    getState: () => initialState,
    subscribe: vi.fn(),
    dispatch: vi.fn(),
  };
};

export const mockUseStore = (mockState: any) => {
  vi.mock('@/store', async () => {
    const actual = await vi.importActual('@/store');
    return {
      ...actual,
      useStore: vi.fn(() => mockState),
    };
  });
};

// Mock 配置管理器
export const mockConfigManager = () => {
  return {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getCurrentModel: vi.fn(),
    getAllModels: vi.fn(),
    getAvailableModels: vi.fn(),
  };
};

// Mock 会话管理器
export const mockSessionManager = () => {
  return {
    getCurrentSession: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    getSessionHistory: vi.fn(),
  };
};

// Mock 工具执行器
export const mockToolExecutor = () => {
  return {
    execute: vi.fn(),
    executeWithConfirmation: vi.fn(),
  };
};

// Mock 日志记录器
export const mockLogger = () => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
};

// Mock 事件发射器
export class MockEventEmitter {
  private listeners: Map<string, Array<Function>> = new Map();

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: Function) {
    if (this.listeners.has(event)) {
      const updated = this.listeners.get(event)!.filter((fn) => fn !== callback);
      this.listeners.set(event, updated);
    }
  }

  emit(event: string, ...args: any[]) {
    if (this.listeners.has(event)) {
      this.listeners.get(event)!.forEach((callback) => callback(...args));
    }
  }

  removeAllListeners(event?: string) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

// Mock 上下文管理器
export const mockContextManager = () => {
  return {
    addMessage: vi.fn(),
    getMessages: vi.fn(),
    clearMessages: vi.fn(),
    getCurrentSessionId: vi.fn(),
    createSession: vi.fn(),
    switchSession: vi.fn(),
  };
};

// Mock 主题管理器
export const mockThemeManager = () => {
  return {
    getCurrentTheme: vi.fn(),
    applyTheme: vi.fn(),
    updateTheme: vi.fn(),
  };
};

// Mock 测试工具
export const waitForAsyncUpdates = async (timeout = 100) => {
  return new Promise((resolve) => setTimeout(resolve, timeout));
};

// Mock 网络请求
export const mockFetch = () => {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      ok: true,
      status: 200,
    } as Response)
  );
};

// Mock DOM 环境
export const mockDOMEnvironment = () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
};

// Mock ResizeObserver
export const mockResizeObserver = () => {
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  window.ResizeObserver = MockResizeObserver;
};

// Mock IntersectionObserver
export const mockIntersectionObserver = () => {
  class MockIntersectionObserver {
    constructor(
      public callback: IntersectionObserverCallback,
      public options?: IntersectionObserverInit
    ) {}

    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
  }
  window.IntersectionObserver = MockIntersectionObserver as any;
};

// Mock requestAnimationFrame
export const mockRequestAnimationFrame = () => {
  window.requestAnimationFrame = vi.fn((callback) => {
    callback(0);
    return 0;
  });
  window.cancelAnimationFrame = vi.fn();
};

// 通用的测试工具函数
export const runTestSuite = (tests: Array<() => void | Promise<void>>) => {
  tests.forEach((testFn, index) => {
    test(`Test case ${index + 1}`, testFn);
  });
};

// Mock 本地存储
export const mockLocalStorage = () => {
  const localStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
  });
  return localStorageMock;
};

// Mock 会话存储
export const mockSessionStorage = () => {
  const sessionStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  Object.defineProperty(window, 'sessionStorage', {
    value: sessionStorageMock,
  });
  return sessionStorageMock;
};
