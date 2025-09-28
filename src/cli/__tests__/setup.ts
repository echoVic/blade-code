import { jest } from '@jest/globals';
import React from 'react';

// 模拟 React hooks
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: jest.fn((initialValue) => {
    const [value, setValue] = jest.requireActual('react').useState(initialValue);
    return [value, setValue];
  }),
  useEffect: jest.fn((callback) => {
    callback();
  }),
  useMemo: jest.fn((factory) => factory()),
  useCallback: jest.fn((callback) => callback),
  useRef: jest.fn((initialValue) => ({
    current: initialValue
  }))
}));

// 模拟 Ink 组件
jest.mock('ink', () => ({
  ...jest.requireActual('ink'),
  useApp: jest.fn(() => ({
    exit: jest.fn(),
    redraw: jest.fn()
  })),
  useInput: jest.fn(() => ({
    stdin: process.stdin,
    setRawMode: jest.fn()
  })),
  useStdout: jest.fn(() => ({
    stdout: process.stdout,
    write: jest.fn(),
    columns: 80,
    rows: 24
  })),
  useStdin: jest.fn(() => ({
    stdin: process.stdin,
    isRawModeSupported: true,
    setRawMode: jest.fn()
  })),
  useFocus: jest.fn(() => ({
    isFocused: true,
    focus: jest.fn(),
    unfocus: jest.fn()
  })),
  useFocusManager: jest.fn(() => ({
    focus: jest.fn(),
    unfocus: jest.fn(),
    activeElement: null
  }))
}));

// 模拟 zustand
jest.mock('zustand', () => ({
  create: (stateCreator) => {
    let state = stateCreator(() => state);
    const listeners = new Set();
    
    return (selector) => {
      if (typeof selector === 'function') {
        return selector(state);
      }
      
      return {
        getState: () => state,
        setState: (partialState) => {
          const newState = typeof partialState === 'function' 
            ? partialState(state) 
            : { ...state, ...partialState };
          state = newState;
          listeners.forEach(listener => listener(state, partialState));
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        destroy: () => {
          listeners.clear();
        }
      };
    };
  }
}));

// 模拟文件系统
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  unlinkSync: jest.fn(),
  rmdirSync: jest.fn(),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
    rmdir: jest.fn()
  }
}));

// 模拟路径模块
jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn((...args) => args.join('/')),
  resolve: jest.fn((...args) => args.join('/')),
  dirname: jest.fn((path) => path.split('/').slice(0, -1).join('/')),
  basename: jest.fn((path) => path.split('/').pop() || ''),
  extname: jest.fn((path) => {
    const lastDot = path.lastIndexOf('.');
    return lastDot === -1 ? '' : path.slice(lastDot);
  })
}));

// 全局测试工具
global.createMockFunction = <T = any>(returnValue?: T, errorValue?: Error) => {
  const mockFn = jest.fn();
  if (errorValue) {
    mockFn.mockImplementation(() => {
      throw errorValue;
    });
  } else if (returnValue !== undefined) {
    mockFn.mockReturnValue(returnValue);
  }
  return mockFn;
};

global.waitForCondition = async (condition: () => boolean, timeout = 1000, interval = 10) => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Condition not met within timeout');
};

// 清理函数，在每个测试后执行
afterEach(() => {
  // 清理所有 mock
  jest.clearAllMocks();
  
  // 清理定时器
  jest.clearAllTimers();
  
  // 清理进程监听器
  process.removeAllListeners();
});

// 设置错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});