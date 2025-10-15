/**
 * 文件系统工具端到端测试
 */

import { promises as fs } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getBuiltinTools } from '../../../src/tools/builtin/index.js';
import { ToolRegistry } from '../../../src/tools/registry/ToolRegistry.js';

describe('文件系统工具 E2E 测试', () => {
  const testDir = path.join(process.cwd(), 'test-temp');
  let registry: ToolRegistry;

  beforeAll(async () => {
    // 创建测试目录
    await fs.mkdir(testDir, { recursive: true });

    // 初始化工具注册表
    registry = new ToolRegistry();
    const builtinTools = await getBuiltinTools();
    registry.registerAll(builtinTools);
  });

  afterAll(async () => {
    // 清理测试目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  describe('工具可用性检查', () => {
    test('应该能加载所有文件系统工具', () => {
      const tools = registry.getAll();
      const toolNames = tools.map((tool: any) => tool.name);

      // 检查关键工具是否存在
      expect(toolNames).toContain('Write');
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Edit');
      expect(toolNames).toContain('Find');
      expect(toolNames).toContain('Glob');
    });
  });

  describe('基础功能验证', () => {
    test('应该能创建测试目录', async () => {
      // 验证测试目录存在
      try {
        await fs.access(testDir);
        expect(true).toBe(true); // 目录存在
      } catch {
        expect(false).toBe(true); // 目录不存在，测试失败
      }
    });

    test('工具注册表应该正常工作', () => {
      // 验证注册表基本功能
      expect(registry).toBeDefined();
      expect(typeof registry.getAll).toBe('function');
      expect(typeof registry.get).toBe('function');
    });

    test('应该能获取工具统计信息', () => {
      const stats = registry.getStats();
      expect(stats).toBeDefined();
      expect(stats.totalTools).toBeGreaterThan(0);
      expect(stats.builtinTools).toBeGreaterThan(0);
    });
  });
});
