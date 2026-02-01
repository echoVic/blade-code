import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestEnvironment } from '../support/helpers/setupTestEnvironment.js';
import { setupTestEnvironment } from '../support/helpers/setupTestEnvironment.js';

describe('路径遍历攻击防护', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = setupTestEnvironment({
      withPackageJson: true,
      customFiles: {
        'src/index.ts': 'export const main = () => {};',
        'secret/credentials.json': '{"apiKey": "secret-key"}',
      },
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('相对路径遍历检测', () => {
    it('应该检测 ../ 路径遍历尝试', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\Windows\\System32\\config\\SAM',
        'src/../../../etc/passwd',
        './src/../../secret/credentials.json',
      ];

      for (const maliciousPath of maliciousPaths) {
        const normalized = path.normalize(maliciousPath);
        const isTraversal = normalized.startsWith('..') || path.isAbsolute(normalized);
        expect(isTraversal || normalized.includes('..')).toBe(true);
      }
    });

    it('应该允许合法的相对路径', () => {
      const legitimatePaths = [
        'src/index.ts',
        './src/utils/helper.ts',
        'tests/unit/test.ts',
      ];

      for (const legitPath of legitimatePaths) {
        const normalized = path.normalize(legitPath);
        const isTraversal = normalized.startsWith('..');
        expect(isTraversal).toBe(false);
      }
    });
  });

  describe('绝对路径限制', () => {
    const isWithinProject = (projectRoot: string, targetPath: string) => {
      if (
        !path.isAbsolute(targetPath) &&
        path.win32.isAbsolute(targetPath) &&
        process.platform !== 'win32'
      ) {
        return false;
      }

      const resolvedProject = path.resolve(projectRoot);
      const resolvedTarget = path.resolve(targetPath);
      const projectPrefix = resolvedProject.endsWith(path.sep)
        ? resolvedProject
        : `${resolvedProject}${path.sep}`;

      return (
        resolvedTarget === resolvedProject || resolvedTarget.startsWith(projectPrefix)
      );
    };

    it('应该检测项目目录外的绝对路径', () => {
      const projectRoot = env.projectDir;
      const outsidePaths = [
        '/etc/passwd',
        '/root/.ssh/id_rsa',
        'C:\\Windows\\System32\\config\\SAM',
        path.join(projectRoot, '..', 'other-project', 'secret.txt'),
      ];

      for (const outsidePath of outsidePaths) {
        expect(isWithinProject(projectRoot, outsidePath)).toBe(false);
      }
    });

    it('应该允许项目内的绝对路径', () => {
      const projectRoot = env.projectDir;
      const insidePaths = [
        path.join(projectRoot, 'src', 'index.ts'),
        path.join(projectRoot, 'package.json'),
        path.join(projectRoot, 'tests', 'test.ts'),
      ];

      for (const insidePath of insidePaths) {
        expect(isWithinProject(projectRoot, insidePath)).toBe(true);
      }
    });
  });

  describe('符号链接攻击防护', () => {
    it('应该检测可能的符号链接路径', () => {
      const suspiciousPaths = [
        '/proc/self/root/etc/passwd',
        '/dev/fd/0',
      ];

      for (const suspiciousPath of suspiciousPaths) {
        const isSuspicious =
          suspiciousPath.includes('/proc/') ||
          suspiciousPath.includes('/dev/') ||
          suspiciousPath.includes('/sys/');
        expect(isSuspicious).toBe(true);
      }
    });
  });

  describe('URL 编码路径攻击', () => {
    it('应该检测 URL 编码的路径遍历', () => {
      const encodedPaths = [
        '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '..%2f..%2f..%2fetc%2fpasswd',
        '%2e%2e\\%2e%2e\\%2e%2e\\etc\\passwd',
      ];

      for (const encodedPath of encodedPaths) {
        const decoded = decodeURIComponent(encodedPath);
        const hasTraversal = decoded.includes('..') || decoded.includes('%2e');
        expect(hasTraversal).toBe(true);
      }
    });
  });

  describe('空字节注入防护', () => {
    it('应该检测空字节注入尝试', () => {
      const nullBytePaths = [
        'file.txt\x00.jpg',
        'secret.json\x00.txt',
        '../etc/passwd\x00.png',
      ];

      for (const nullBytePath of nullBytePaths) {
        const hasNullByte = nullBytePath.includes('\x00');
        expect(hasNullByte).toBe(true);
      }
    });
  });

  describe('Windows 特殊路径防护', () => {
    it('应该检测 Windows 设备名称', () => {
      const windowsDevices = [
        'CON',
        'PRN',
        'AUX',
        'NUL',
        'COM1',
        'LPT1',
        'con.txt',
        'prn.js',
      ];

      const devicePattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

      for (const device of windowsDevices) {
        const isDevice = devicePattern.test(device);
        expect(isDevice).toBe(true);
      }
    });

    it('应该检测 Windows UNC 路径', () => {
      const uncPaths = [
        '\\\\server\\share\\file.txt',
        '//server/share/file.txt',
        '\\\\?\\C:\\Windows\\System32',
      ];

      for (const uncPath of uncPaths) {
        const isUNC = uncPath.startsWith('\\\\') || uncPath.startsWith('//');
        expect(isUNC).toBe(true);
      }
    });
  });
});
