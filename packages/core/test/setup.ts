/**
 * Vitest 测试设置文件
 */

import { vi } from 'vitest';

// 模拟全局对象
global.console = {
  ...console,
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn()
};

// 模拟AbortController
if (!global.AbortController) {
  global.AbortController = class AbortController {
    signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    };
    
    abort() {
      (this.signal as any).aborted = true;
    }
  } as any;
}

// 模拟fetch
if (!global.fetch) {
  global.fetch = vi.fn();
}