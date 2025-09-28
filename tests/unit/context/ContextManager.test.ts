/**
 * ContextManager 单元测试
 */

import { ContextManager } from '../ContextManager.js';
import { ContextCompressor } from '../processors/ContextCompressor.js';
import { ContextFilter } from '../processors/ContextFilter.js';
import { MemoryStore } from '../storage/MemoryStore.js';
import { PersistentStore } from '../storage/PersistentStore.js';
import { ContextConfig, ContextEntry } from '../types.js';

// Mock 处理器
const mockCompressor = {
  compress: jest.fn().mockImplementation((entries) => Promise.resolve(entries)),
  decompress: jest.fn().mockImplementation((entries) => Promise.resolve(entries)),
};

const mockFilter = {
  filter: jest.fn().mockImplementation((entries) => entries),
};

// Mock 存储
const mockMemoryStore = {
  get: jest.fn().mockResolvedValue([]),
  set: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
};

const mockPersistentStore = {
  load: jest.fn().mockResolvedValue([]),
  save: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
};

// Mock 模块
jest.mock('../processors/ContextCompressor.js', () => {
  return {
    ContextCompressor: jest.fn().mockImplementation(() => mockCompressor),
  };
});

jest.mock('../processors/ContextFilter.js', () => {
  return {
    ContextFilter: jest.fn().mockImplementation(() => mockFilter),
  };
});

jest.mock('../storage/MemoryStore.js', () => {
  return {
    MemoryStore: jest.fn().mockImplementation(() => mockMemoryStore),
  };
});

jest.mock('../storage/PersistentStore.js', () => {
  return {
    PersistentStore: jest.fn().mockImplementation(() => mockPersistentStore),
  };
});

describe('ContextManager', () => {
  let contextManager: ContextManager;
  let defaultConfig: ContextConfig;

  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();

    // 默认配置
    defaultConfig = {
      maxSize: 100,
      compression: true,
      persistence: true,
      persistencePath: '/tmp/context.json',
      filter: {
        maxAge: 86400000, // 24 hours
        maxEntries: 50,
      },
    };

    // 创建新的 ContextManager 实例
    contextManager = new ContextManager(defaultConfig);
  });

  afterEach(async () => {
    // 销毁 contextManager 实例
    if (contextManager) {
      await contextManager.destroy();
    }
  });

  describe('初始化', () => {
    test('应该成功创建 ContextManager 实例', () => {
      expect(contextManager).toBeInstanceOf(ContextManager);
    });

    test('应该正确初始化配置', () => {
      const config = (contextManager as any).config;
      expect(config).toEqual(defaultConfig);
    });

    test('应该创建处理器和存储实例', () => {
      expect(ContextCompressor).toHaveBeenCalled();
      expect(ContextFilter).toHaveBeenCalled();
      expect(MemoryStore).toHaveBeenCalled();
      expect(PersistentStore).toHaveBeenCalled();
    });
  });

  describe('上下文条目管理', () => {
    test('应该能够添加上下文条目', () => {
      const entry: ContextEntry = {
        id: 'test-1',
        type: 'user-message',
        content: 'Hello, world!',
        timestamp: new Date().toISOString(),
      };

      const result = contextManager.addEntry(entry);

      expect(result).toBeDefined();
      expect(result.id).toBe('test-1');
      expect(result.type).toBe('user-message');
    });

    test('应该自动生成条目 ID', () => {
      const entry: ContextEntry = {
        type: 'user-message',
        content: 'Hello, world!',
        timestamp: new Date().toISOString(),
      };

      const result = contextManager.addEntry(entry);

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });

    test('应该维护最大大小限制', () => {
      // 添加超过最大大小的条目
      for (let i = 0; i < 110; i++) {
        contextManager.addEntry({
          type: 'test',
          content: `Test message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      const entries = contextManager.getEntries();
      expect(entries.length).toBe(100); // 应该只保留最新的100条
    });

    test('应该能够获取所有条目', () => {
      // 添加一些条目
      contextManager.addEntry({
        type: 'user-message',
        content: 'First message',
        timestamp: new Date().toISOString(),
      });

      contextManager.addEntry({
        type: 'assistant-response',
        content: 'First response',
        timestamp: new Date().toISOString(),
      });

      const entries = contextManager.getEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('user-message');
      expect(entries[1].type).toBe('assistant-response');
    });

    test('应该能够通过 ID 获取条目', () => {
      const entry = contextManager.addEntry({
        type: 'user-message',
        content: 'Test message',
        timestamp: new Date().toISOString(),
      });

      const retrieved = contextManager.getEntry(entry.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(entry.id);
      expect(retrieved?.content).toBe('Test message');
    });

    test('应该返回 null 对于不存在的条目', () => {
      const retrieved = contextManager.getEntry('non-existent');

      expect(retrieved).toBeNull();
    });
  });

  describe('上下文获取', () => {
    beforeEach(() => {
      // 添加一些测试条目
      contextManager.addEntry({
        type: 'user-message',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      });

      contextManager.addEntry({
        type: 'assistant-response',
        content: 'Hi there!',
        timestamp: new Date().toISOString(),
      });
    });

    test('应该能够获取格式化的上下文', () => {
      const context = contextManager.getContext();

      expect(context).toBeDefined();
      expect(context.entries).toHaveLength(2);
      expect(Array.isArray(context.entries)).toBe(true);
    });

    test('应该应用过滤器', () => {
      contextManager.getContext();

      expect(mockFilter.filter).toHaveBeenCalled();
    });
  });

  describe('上下文清空', () => {
    beforeEach(() => {
      // 添加一些测试条目
      contextManager.addEntry({
        type: 'user-message',
        content: 'Test message',
        timestamp: new Date().toISOString(),
      });
    });

    test('应该能够清空所有条目', () => {
      expect(contextManager.getEntries()).toHaveLength(1);

      contextManager.clear();

      expect(contextManager.getEntries()).toHaveLength(0);
    });

    test('应该在清空时重置内部状态', () => {
      contextManager.clear();

      const context = contextManager.getContext();
      expect(context.entries).toHaveLength(0);
    });
  });

  describe('上下文压缩', () => {
    beforeEach(() => {
      // 添加一些测试条目
      for (let i = 0; i < 5; i++) {
        contextManager.addEntry({
          type: 'user-message',
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
    });

    test('应该能够压缩上下文', async () => {
      await contextManager.compress();

      expect(mockCompressor.compress).toHaveBeenCalled();
    });

    test('应该在压缩错误时正确处理', async () => {
      mockCompressor.compress.mockRejectedValueOnce(new Error('Compression Error'));

      await expect(contextManager.compress()).rejects.toThrow('Compression Error');
    });

    test('应该在禁用压缩时不执行压缩', async () => {
      const manager = new ContextManager({
        ...defaultConfig,
        compression: false,
      });

      await manager.compress();

      expect(mockCompressor.compress).not.toHaveBeenCalled();

      await manager.destroy();
    });
  });

  describe('持久化', () => {
    beforeEach(() => {
      // 添加一些测试条目
      contextManager.addEntry({
        type: 'user-message',
        content: 'Test message',
        timestamp: new Date().toISOString(),
      });
    });

    test('应该能够持久化上下文', async () => {
      await contextManager.persist();

      expect(mockMemoryStore.set).toHaveBeenCalled();
      expect(mockPersistentStore.save).toHaveBeenCalled();
    });

    test('应该能够从持久化存储恢复上下文', async () => {
      // 模拟持久化存储中有数据
      mockPersistentStore.load.mockResolvedValueOnce([
        {
          id: 'persisted-1',
          type: 'user-message',
          content: 'Persisted message',
          timestamp: new Date().toISOString(),
        },
      ]);

      await contextManager.restore();

      expect(mockPersistentStore.load).toHaveBeenCalled();
      expect(mockMemoryStore.set).toHaveBeenCalled();
    });

    test('应该在持久化错误时正确处理', async () => {
      mockPersistentStore.save.mockRejectedValueOnce(new Error('Persistence Error'));

      await expect(contextManager.persist()).rejects.toThrow('Persistence Error');
    });

    test('应该在禁用持久化时不执行持久化', async () => {
      const manager = new ContextManager({
        ...defaultConfig,
        persistence: false,
      });

      await manager.persist();

      expect(mockPersistentStore.save).not.toHaveBeenCalled();

      await manager.destroy();
    });
  });

  describe('销毁', () => {
    test('应该正确销毁 ContextManager', async () => {
      await contextManager.destroy();

      expect(mockMemoryStore.destroy).toHaveBeenCalled();
      expect(mockPersistentStore.destroy).toHaveBeenCalled();
    });

    test('应该能够多次安全调用销毁', async () => {
      await contextManager.destroy();
      await contextManager.destroy(); // 第二次调用

      // 应该不会出错
      expect(mockMemoryStore.destroy).toHaveBeenCalledTimes(1);
      expect(mockPersistentStore.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('错误处理', () => {
    test('应该处理无效的上下文条目', () => {
      expect(() => contextManager.addEntry({} as any)).toThrow(
        'Context entry must have a type and content'
      );

      expect(() =>
        contextManager.addEntry({
          type: 'test',
          // 缺少 content
        } as any)
      ).toThrow('Context entry must have a type and content');
    });

    test('应该处理存储错误', async () => {
      mockMemoryStore.set.mockRejectedValueOnce(new Error('Storage Error'));

      await expect(contextManager.persist()).rejects.toThrow('Storage Error');
    });
  });

  describe('配置管理', () => {
    test('应该能够使用不同的配置创建实例', () => {
      const customConfig: ContextConfig = {
        maxSize: 50,
        compression: false,
        persistence: false,
        filter: {
          maxAge: 3600000, // 1 hour
          maxEntries: 25,
        },
      };

      const manager = new ContextManager(customConfig);

      expect(manager).toBeInstanceOf(ContextManager);

      manager.destroy();
    });

    test('应该应用默认配置', () => {
      const manager = new ContextManager({});

      const config = (manager as any).config;
      expect(config.maxSize).toBe(1000); // 默认值
      expect(config.compression).toBe(true);
      expect(config.persistence).toBe(false);

      manager.destroy();
    });
  });
});
