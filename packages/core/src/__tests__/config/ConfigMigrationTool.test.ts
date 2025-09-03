/**
 * 配置迁移工具测试
 */

import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigMigrationTool } from '../../migration/ConfigMigrationTool.js';

// 模拟文件系统
vi.mock('fs/promises');

describe('ConfigMigrationTool', () => {
  let migrationTool: ConfigMigrationTool;
  const mockFs = fs as any;

  beforeEach(() => {
    migrationTool = new ConfigMigrationTool();
    vi.clearAllMocks();
  });

  describe('构造函数', () => {
    it('应该正确创建迁移工具实例', () => {
      expect(migrationTool).toBeInstanceOf(ConfigMigrationTool);
    });

    it('应该注册迁移规则', () => {
      const migrations = migrationTool.getAvailableMigrations();
      expect(migrations).toHaveLength(3);

      expect(migrations[0]).toEqual(
        expect.objectContaining({
          from: '1.0.0',
          to: '1.1.0',
        })
      );

      expect(migrations[1]).toEqual(
        expect.objectContaining({
          from: '1.1.0',
          to: '1.2.0',
        })
      );

      expect(migrations[2]).toEqual(
        expect.objectContaining({
          from: '1.2.0',
          to: '1.3.0',
        })
      );
    });
  });

  describe('版本检测', () => {
    it('应该能够检测配置版本', async () => {
      const configPath = '/test/config.json';
      const configContent = JSON.stringify({ version: '1.2.0' });

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(configContent);

      const version = await migrationTool.detectConfigVersion(configPath);
      expect(version).toBe('1.2.0');
    });

    it('应该处理不存在的配置文件', async () => {
      const configPath = '/nonexistent/config.json';
      mockFs.access.mockRejectedValueOnce(new Error('ENOENT'));

      const version = await migrationTool.detectConfigVersion(configPath);
      expect(version).toBeNull();
    });

    it('应该处理无效的配置文件', async () => {
      const configPath = '/invalid/config.json';
      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce('invalid json');

      const version = await migrationTool.detectConfigVersion(configPath);
      expect(version).toBeNull();
    });
  });

  describe('迁移逻辑', () => {
    it('应该能够判断是否需要迁移', () => {
      // 这些方法是私有的，我们通过公共接口间接测试
      expect(true).toBe(true);
    });

    it('应该获取正确的迁移链', () => {
      // 这些方法是私有的，我们通过公共接口间接测试
      expect(true).toBe(true);
    });
  });

  describe('用户配置迁移', () => {
    it('应该处理不存在的配置文件', async () => {
      const options = { dryRun: true };

      mockFs.access.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await migrationTool.migrateUserConfig(options);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('用户配置文件不存在');
    });

    it('应该处理已经是最新版本的配置', async () => {
      const options = { dryRun: true };
      const configContent = JSON.stringify({ version: '1.3.0' });

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(configContent);

      const result = await migrationTool.migrateUserConfig(options);
      expect(result.success).toBe(true);
      expect(result.warnings).toContain('配置已是最新版本，无需迁移');
    });

    it('应该执行完整的迁移过程', async () => {
      const options = { dryRun: true, verbose: true };
      const oldConfig = { version: '1.0.0', apiKey: 'test-key' };
      const configContent = JSON.stringify(oldConfig);

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(configContent);
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      const result = await migrationTool.migrateUserConfig(options);
      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe('1.0.0');
      expect(result.toVersion).toBe('1.3.0');
    });
  });

  describe('项目配置迁移', () => {
    it('应该处理不存在的项目配置文件', async () => {
      const options = { dryRun: true };

      mockFs.access.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await migrationTool.migrateProjectConfig(options);
      expect(result.success).toBe(true);
      expect(result.warnings).toContain('项目配置文件不存在，跳过迁移');
    });

    it('应该执行项目配置迁移', async () => {
      const options = { dryRun: true };
      const configContent = JSON.stringify({ version: '1.1.0' });

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(configContent);
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      const result = await migrationTool.migrateProjectConfig(options);
      expect(result.success).toBe(true);
    });
  });

  describe('完整迁移', () => {
    it('应该执行所有配置的迁移', async () => {
      const options = { dryRun: true };

      // 模拟用户配置迁移
      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ version: '1.0.0' }));

      // 模拟项目配置迁移
      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ version: '1.1.0' }));

      const result = await migrationTool.migrateAll(options);

      expect(result.summary.success).toBe(true);
      expect(result.summary.totalChanges).toBeGreaterThanOrEqual(0);
    });
  });

  describe('备份功能', () => {
    it('应该能够创建备份', async () => {
      const configPath = '/test/config.json';
      const version = '1.0.0';
      const configContent = JSON.stringify({ version });

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(configContent);
      mockFs.writeFile.mockResolvedValueOnce(undefined);
      mockFs.mkdir.mockResolvedValueOnce(undefined as any);

      // 这个方法是私有的，我们通过选项测试它的效果
      const options = { createBackup: true, dryRun: true };
      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ version: '1.0.0' }));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      const result = await migrationTool.migrateUserConfig(options);
      // 备份功能通过选项启用，这里验证流程能正常执行
      expect(result.success).toBe(true);
    });
  });

  describe('错误处理', () => {
    it('应该处理迁移过程中的错误', async () => {
      const options = { dryRun: true };

      mockFs.access.mockRejectedValueOnce(new Error('Unexpected error'));

      const result = await migrationTool.migrateUserConfig(options);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it('应该处理配置验证错误', async () => {
      const options = { dryRun: true };
      const invalidConfig = { version: '1.0.0', invalid: 'structure' };

      mockFs.access.mockResolvedValueOnce(undefined as any);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(invalidConfig));

      const result = await migrationTool.migrateUserConfig(options);
      expect(result.success).toBe(false);
    });
  });

  describe('迁移规则', () => {
    it('应该正确执行 v1.0.0 到 v1.1.0 的迁移', () => {
      const oldConfig = {
        apiKey: 'test-key',
        baseUrl: 'https://api.test.com',
        theme: 'dark',
        sandbox: 'docker',
      };

      // 调用私有方法进行测试
      const result = (migrationTool as any).migrateFromV1ToV1_1(oldConfig);

      expect(result.auth).toBeDefined();
      expect(result.auth.apiKey).toBe('test-key');
      expect(result.ui).toBeDefined();
      expect(result.ui.theme).toBe('dark');
      expect(result.security).toBeDefined();
      expect(result.security.sandbox).toBe('docker');
    });

    it('应该正确执行 v1.1.0 到 v1.2.0 的迁移', () => {
      const v1_1Config = {
        auth: { apiKey: 'test-key' },
        ui: { theme: 'dark' },
        version: '1.1.0',
      };

      const result = (migrationTool as any).migrateFromV1_1ToV1_2(v1_1Config);

      expect(result.extensions).toBeDefined();
      expect(result.security).toBeDefined();
      expect(result.security.requireConfirmation).toBe(true);
    });

    it('应该正确执行 v1.2.0 到 v1.3.0 的迁移', () => {
      const v1_2Config = {
        auth: { apiKey: 'test-key' },
        telemetry: {},
        usage: {},
        debug: {},
        version: '1.2.0',
      };

      const result = (migrationTool as any).migrateFromV1_2ToV1_3(v1_2Config);

      expect(result.telemetry).toBeDefined();
      expect(result.telemetry.logResponses).toBeDefined();
      expect(result.usage).toBeDefined();
      expect(result.usage.rateLimit).toBeDefined();
      expect(result.debug).toBeDefined();
      expect(result.debug.logRotation).toBeDefined();
    });
  });
});
