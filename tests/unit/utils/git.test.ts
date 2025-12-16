/**
 * Git 工具函数测试
 *
 * 注意：这些测试主要验证纯函数逻辑，
 * 避免执行实际的 Git 命令以防止 CI 超时
 */

import { describe, expect, it } from 'vitest';
import {
  extractRepoName,
  GitCloneProgressParser,
  sanitizeGitUrl,
  validateDestinationPath,
  validateGitUrl,
} from '../../../src/utils/git.js';

describe('Git 工具函数', () => {
  describe('validateGitUrl', () => {
    it('应该验证有效的 HTTPS URL', () => {
      expect(validateGitUrl('https://github.com/user/repo.git')).toBe(true);
      expect(validateGitUrl('https://github.com/user/repo')).toBe(true);
      expect(validateGitUrl('https://gitlab.com/user/repo.git')).toBe(true);
    });

    it('应该验证有效的 SSH URL', () => {
      expect(validateGitUrl('git@github.com:user/repo.git')).toBe(true);
      expect(validateGitUrl('git@gitlab.com:user/repo')).toBe(true);
    });

    it('应该拒绝无效的 URL', () => {
      expect(validateGitUrl('not-a-url')).toBe(false);
      expect(validateGitUrl('ftp://example.com/repo')).toBe(false);
      expect(validateGitUrl('')).toBe(false);
    });
  });

  describe('sanitizeGitUrl', () => {
    it('应该移除危险字符', () => {
      expect(sanitizeGitUrl('https://github.com/user/repo.git; rm -rf /')).toBe(
        'https://github.com/user/repo.git'
      );
      expect(sanitizeGitUrl('https://github.com/user/repo.git | cat /etc/passwd')).toBe(
        'https://github.com/user/repo.git'
      );
      expect(sanitizeGitUrl('https://github.com/user/repo.git$(whoami)')).toBe(
        'https://github.com/user/repo.git'
      );
    });

    it('应该保留正常的 URL', () => {
      expect(sanitizeGitUrl('https://github.com/user/repo.git')).toBe(
        'https://github.com/user/repo.git'
      );
    });
  });

  describe('validateDestinationPath', () => {
    it('应该拒绝系统目录', () => {
      expect(validateDestinationPath('/etc/something').valid).toBe(false);
      expect(validateDestinationPath('/usr/local').valid).toBe(false);
      expect(validateDestinationPath('/var/log').valid).toBe(false);
    });

    it('应该允许普通目录', () => {
      expect(validateDestinationPath('/tmp/repos').valid).toBe(true);
      expect(validateDestinationPath('/home/user/projects').valid).toBe(true);
    });
  });

  describe('extractRepoName', () => {
    it('应该从 URL 中提取仓库名', () => {
      expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
      expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
      expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });
  });

  describe('GitCloneProgressParser', () => {
    it('应该解析 Receiving objects 进度', () => {
      const parser = new GitCloneProgressParser();

      const progress1 = parser.parse('Receiving objects:  50% (100/200)');
      expect(progress1).not.toBeNull();
      expect(progress1?.percent).toBe(50);

      const progress2 = parser.parse('Receiving objects: 100% (200/200)');
      expect(progress2).not.toBeNull();
      expect(progress2?.percent).toBe(100);
    });

    it('应该解析中文 Git 输出', () => {
      const parser = new GitCloneProgressParser();

      const progress = parser.parse('接收对象中:  75% (150/200)');
      expect(progress).not.toBeNull();
      expect(progress?.percent).toBe(75);
    });

    it('应该正确计算多阶段进度', () => {
      const parser = new GitCloneProgressParser();

      // 模拟完整的克隆过程
      parser.parse('Receiving objects: 100% (200/200)');

      const resolvingProgress = parser.parse('Resolving deltas:  50% (50/100)');
      expect(resolvingProgress).not.toBeNull();
      // 应该是 80% (receiving 完成) + 10% (resolving 一半)
      expect(resolvingProgress?.percent).toBeGreaterThanOrEqual(80);
    });

    it('应该确保进度单调递增', () => {
      const parser = new GitCloneProgressParser();

      const progress1 = parser.parse('Receiving objects:  50% (100/200)');
      const progress2 = parser.parse('Receiving objects:  30% (60/200)'); // 模拟进度回退

      expect(progress1).not.toBeNull();
      expect(progress2).not.toBeNull();
      expect(progress2!.percent).toBeGreaterThanOrEqual(progress1!.percent);
    });
  });
});
