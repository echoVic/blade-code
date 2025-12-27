/**
 * UI 测试工具
 * 为 UI 组件测试提供专门的工具和辅助函数
 */

import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    useId: () => 'test-id',
  };
});

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

export const mockConfigManager = () => {
  return {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getCurrentModel: vi.fn(),
    getAllModels: vi.fn(),
    getAvailableModels: vi.fn(),
  };
};

export const mockSessionManager = () => {
  return {
    getCurrentSession: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    getSessionHistory: vi.fn(),
  };
};

export const mockToolExecutor = () => {
  return {
    execute: vi.fn(),
    executeWithConfirmation: vi.fn(),
  };
};

export const mockLogger = () => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
};

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

export const mockThemeManager = () => {
  return {
    getCurrentTheme: vi.fn(),
    applyTheme: vi.fn(),
    updateTheme: vi.fn(),
  };
};

export const waitForAsyncUpdates = async (timeout = 100) => {
  return new Promise((resolve) => setTimeout(resolve, timeout));
};

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

export const mockResizeObserver = () => {
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  window.ResizeObserver = MockResizeObserver;
};

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

export const mockRequestAnimationFrame = () => {
  window.requestAnimationFrame = vi.fn((callback) => {
    callback(0);
    return 0;
  });
  window.cancelAnimationFrame = vi.fn();
};

export const runTestSuite = (tests: Array<() => void | Promise<void>>) => {
  tests.forEach((testFn, index) => {
    test(`Test case ${index + 1}`, testFn);
  });
};

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

export const renderHookWithAct = async (callback: any, options?: any) => {
  let result: any;
  await act(async () => {
    result = renderHook(callback, options);
  });
  return result!;
};
