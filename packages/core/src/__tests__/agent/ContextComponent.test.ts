/**
 * ContextComponent 单元测试
 */

import { ContextComponent } from '../ContextComponent.js';
import { Agent } from '../Agent.js';
import { ContextManager } from '../../context/ContextManager.js';

// Mock Agent
const mockAgent = {
  getConfig: jest.fn().mockReturnValue({
    context: {
      maxSize: 100,
      compression: true,
      persistence: true
    }
  }),
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  })
};

// Mock Context Entry
const mockContextEntry = {
  id: 'test-1',
  type: 'user-message',
  content: 'Hello, world!',
  timestamp: new Date().toISOString(),
  metadata: {
    userId: 'user-123'
  }
};

// Mock ContextManager
const mockContextManager = {
  addEntry: jest.fn().mockReturnValue(mockContextEntry),
  getEntries: jest.fn().mockReturnValue([mockContextEntry]),
  getContext: jest.fn().mockReturnValue({ entries: [mockContextEntry] }),
  clear: jest.fn().mockReturnValue(undefined),
  compress: jest.fn().mockResolvedValue(undefined),
  persist: jest.fn().mockResolvedValue(undefined),
  restore: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../../context/ContextManager.js', () => {
  return {
    ContextManager: jest.fn().mockImplementation(() => mockContextManager)
  };
});

describe('ContextComponent', () => {
  let contextComponent: ContextComponent;
  
  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    // 创建新的 ContextComponent 实例
    contextComponent = new ContextComponent(mockAgent as unknown as Agent);
  });
  
  afterEach(() => {
    // 销毁 contextComponent 实例
    if (contextComponent) {
      contextComponent.destroy();
    }
  });
  
  describe('初始化', () => {
    test('应该成功创建 ContextComponent 实例', () => {
      expect(contextComponent).toBeInstanceOf(ContextComponent);
    });
    
    test('应该能够正确初始化 ContextManager', async () => {
      await contextComponent.initialize();
      
      expect(ContextManager).toHaveBeenCalled();
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
    
    test('应该正确设置状态', async () => {
      expect(contextComponent.isInitialized()).toBe(false);
      
      await contextComponent.initialize();
      
      expect(contextComponent.isInitialized()).toBe(true);
    });
    
    test('应该在初始化失败时正确处理', async () => {
      (ContextManager as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Init Error');
      });
      
      await expect(contextComponent.initialize()).rejects.toThrow('Init Error');
      expect(contextComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('上下文管理', () => {
    beforeEach(async () => {
      await contextComponent.initialize();
    });
    
    test('应该能够添加上下文条目', () => {
      const entry = contextComponent.addContext({
        type: 'user-message',
        content: 'Hello, world!'
      });
      
      expect(entry).toBeDefined();
      expect(entry.type).toBe('user-message');
      expect(entry.content).toBe('Hello, world!');
      expect(mockContextManager.addEntry).toHaveBeenCalled();
    });
    
    test('应该能够获取上下文', () => {
      const context = contextComponent.getContext();
      
      expect(context).toBeDefined();
      expect(context.entries).toEqual([mockContextEntry]);
      expect(mockContextManager.getContext).toHaveBeenCalled();
    });
    
    test('应该能够获取上下文条目', () => {
      const entries = contextComponent.getEntries();
      
      expect(entries).toEqual([mockContextEntry]);
      expect(mockContextManager.getEntries).toHaveBeenCalled();
    });
    
    test('应该能够清空上下文', () => {
      contextComponent.clear();
      
      expect(mockContextManager.clear).toHaveBeenCalled();
    });
  });
  
  describe('上下文压缩', () => {
    beforeEach(async () => {
      await contextComponent.initialize();
    });
    
    test('应该能够压缩上下文', async () => {
      await contextComponent.compress();
      
      expect(mockContextManager.compress).toHaveBeenCalled();
    });
    
    test('应该在压缩错误时正确处理', async () => {
      mockContextManager.compress.mockRejectedValueOnce(new Error('Compression Error'));
      
      await expect(contextComponent.compress()).rejects.toThrow('Compression Error');
      const logger = mockAgent.getLogger();
      expect(logger.error).toHaveBeenCalled();
    });
  });
  
  describe('持久化', () => {
    beforeEach(async () => {
      await contextComponent.initialize();
    });
    
    test('应该能够持久化上下文', async () => {
      await contextComponent.persist();
      
      expect(mockContextManager.persist).toHaveBeenCalled();
    });
    
    test('应该能够恢复上下文', async () => {
      await contextComponent.restore();
      
      expect(mockContextManager.restore).toHaveBeenCalled();
    });
    
    test('应该在持久化错误时正确处理', async () => {
      mockContextManager.persist.mockRejectedValueOnce(new Error('Persistence Error'));
      
      await expect(contextComponent.persist()).rejects.toThrow('Persistence Error');
      const logger = mockAgent.getLogger();
      expect(logger.error).toHaveBeenCalled();
    });
  });
  
  describe('销毁', () => {
    beforeEach(async () => {
      await contextComponent.initialize();
    });
    
    test('应该正确销毁 ContextComponent', async () => {
      await contextComponent.destroy();
      
      expect(mockContextManager.destroy).toHaveBeenCalled();
      expect(contextComponent.isInitialized()).toBe(false);
    });
    
    test('应该能够多次安全调用销毁', async () => {
      await contextComponent.destroy();
      await contextComponent.destroy(); // 第二次调用
      
      // 应该不会出错，且 destroy 只调用一次
      expect(mockContextManager.destroy).toHaveBeenCalledTimes(1);
      expect(contextComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('错误处理', () => {
    test('应该在未初始化时拒绝调用方法', () => {
      expect(() => contextComponent.addContext({ type: 'test', content: 'test' }))
        .toThrow('ContextComponent not initialized');
      
      expect(() => contextComponent.getContext())
        .toThrow('ContextComponent not initialized');
      
      expect(() => contextComponent.getEntries())
        .toThrow('ContextComponent not initialized');
      
      expect(() => contextComponent.clear())
        .toThrow('ContextComponent not initialized');
    });
    
    test('应该处理无效的上下文条目', () => {
      contextComponent.initialize();
      
      expect(() => contextComponent.addContext({} as any))
        .toThrow('Context entry must have a type and content');
    });
  });
  
  describe('配置管理', () => {
    test('应该能够获取上下文配置', async () => {
      await contextComponent.initialize();
      
      const config = (contextComponent as any).getContextConfig();
      
      expect(config).toBeDefined();
      expect(config.maxSize).toBe(100);
      expect(config.compression).toBe(true);
      expect(config.persistence).toBe(true);
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
  });
});