/**
 * SensitiveFileDetector 单元测试
 */

import { describe, expect, it } from 'vitest';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../../../src/tools/validation/SensitiveFileDetector.js';

describe('SensitiveFileDetector', () => {
  describe('高度敏感文件检测', () => {
    it('应该识别 SSH 私钥', () => {
      const result = SensitiveFileDetector.check('~/.ssh/id_rsa');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
      expect(result.reason).toContain('SSH 私钥');
    });

    it('应该识别 .pem 密钥文件', () => {
      const result = SensitiveFileDetector.check('/path/to/private-key.pem');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
      expect(result.reason).toContain('PEM');
    });

    it('应该识别 AWS 凭证文件', () => {
      const result = SensitiveFileDetector.check('~/.aws/credentials');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });

    it('应该识别 Google Cloud 凭证', () => {
      const result = SensitiveFileDetector.check('/app/credentials.json');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
      expect(result.reason).toContain('Google Cloud');
    });

    it('应该识别服务账号密钥', () => {
      const result = SensitiveFileDetector.check(
        '/config/service-account-key.json'
      );
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
    });
  });

  describe('中度敏感文件检测', () => {
    it('应该识别 .env 文件', () => {
      const result = SensitiveFileDetector.check('.env');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
      expect(result.reason).toContain('环境变量');
    });

    it('应该识别 .env.local 等变体', () => {
      const tests = ['.env.local', '.env.production', '.env.development'];

      for (const file of tests) {
        const result = SensitiveFileDetector.check(file);
        expect(result.isSensitive).toBe(true);
        expect(result.level).toBe(SensitivityLevel.MEDIUM);
      }
    });

    it('应该识别 .npmrc 配置', () => {
      const result = SensitiveFileDetector.check('~/.npmrc');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
      expect(result.reason).toContain('npm');
    });

    it('应该识别 .dockercfg 配置文件', () => {
      const result = SensitiveFileDetector.check('~/.dockercfg');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.MEDIUM);
    });
  });

  describe('低度敏感文件检测', () => {
    it('应该识别 SQLite 数据库', () => {
      const result = SensitiveFileDetector.check('app.sqlite');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.LOW);
    });

    it('应该识别 .db 数据库文件', () => {
      const result = SensitiveFileDetector.check('data.db');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.LOW);
    });
  });

  describe('敏感路径检测', () => {
    it('应该识别 .ssh 目录下的文件', () => {
      const result = SensitiveFileDetector.check('~/.ssh/config');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
      expect(result.reason).toContain('SSH');
    });

    it('应该识别 .kube 配置目录', () => {
      const result = SensitiveFileDetector.check('~/.kube/config');
      expect(result.isSensitive).toBe(true);
      expect(result.level).toBe(SensitivityLevel.HIGH);
      expect(result.reason).toContain('Kubernetes');
    });
  });

  describe('非敏感文件检测', () => {
    it('普通源代码文件不应被标记为敏感', () => {
      const files = [
        'src/index.ts',
        'README.md',
        'package.json',
        'tsconfig.json',
      ];

      for (const file of files) {
        const result = SensitiveFileDetector.check(file);
        expect(result.isSensitive).toBe(false);
      }
    });

    it('普通文本文件不应被标记为敏感', () => {
      const result = SensitiveFileDetector.check('notes.txt');
      expect(result.isSensitive).toBe(false);
    });
  });

  describe('filterSensitive 批量检测', () => {
    it('应该过滤出所有敏感文件', () => {
      const files = [
        'src/index.ts',
        '.env',
        '~/.ssh/id_rsa',
        'README.md',
        'credentials.json',
      ];

      const sensitive = SensitiveFileDetector.filterSensitive(files);

      expect(sensitive).toHaveLength(3);
      expect(sensitive.map((s) => s.path)).toContain('.env');
      expect(sensitive.map((s) => s.path)).toContain('~/.ssh/id_rsa');
      expect(sensitive.map((s) => s.path)).toContain('credentials.json');
    });

    it('应该按敏感度级别过滤', () => {
      const files = [
        '.env', // MEDIUM
        '~/.ssh/id_rsa', // HIGH
        'app.db', // LOW
      ];

      // 只返回 MEDIUM 及以上
      const mediumAndAbove = SensitiveFileDetector.filterSensitive(
        files,
        SensitivityLevel.MEDIUM
      );
      expect(mediumAndAbove).toHaveLength(2);

      // 只返回 HIGH
      const highOnly = SensitiveFileDetector.filterSensitive(
        files,
        SensitivityLevel.HIGH
      );
      expect(highOnly).toHaveLength(1);
      expect(highOnly[0].path).toBe('~/.ssh/id_rsa');
    });
  });

  describe('路径规范化', () => {
    it('应该正确处理 ~ 开头的路径', () => {
      const result = SensitiveFileDetector.check('~/.ssh/id_rsa');
      expect(result.isSensitive).toBe(true);
    });

    it('应该正确处理相对路径', () => {
      const result = SensitiveFileDetector.check('./.env');
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('大小写不敏感', () => {
    it('应该识别不同大小写的 .env', () => {
      const tests = ['.ENV', '.Env', '.env'];

      for (const file of tests) {
        const result = SensitiveFileDetector.check(file);
        expect(result.isSensitive).toBe(true);
      }
    });

    it('应该识别不同大小写的密钥文件', () => {
      const tests = ['key.PEM', 'key.pem', 'key.Pem'];

      for (const file of tests) {
        const result = SensitiveFileDetector.check(file);
        expect(result.isSensitive).toBe(true);
      }
    });
  });
});
