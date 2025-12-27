/**
 * PathSecurity 单元测试
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { PathSecurity, PathSecurityError } from '../../../src/utils/pathSecurity.js';

describe('PathSecurity', () => {
  const workspace = process.cwd();

  describe('normalize', () => {
    it('should normalize relative paths', () => {
      const result = PathSecurity.normalize('src/agent.ts', workspace);
      expect(result).toBe(path.join(workspace, 'src/agent.ts'));
    });

    it('should handle absolute paths within workspace', () => {
      const absolutePath = path.join(workspace, 'src/agent.ts');
      const result = PathSecurity.normalize(absolutePath, workspace);
      expect(result).toBe(absolutePath);
    });

    it('should throw error for paths outside workspace', () => {
      expect(() => {
        PathSecurity.normalize('/etc/passwd', workspace);
      }).toThrow(PathSecurityError);

      expect(() => {
        PathSecurity.normalize('/etc/passwd', workspace);
      }).toThrow('Path outside workspace');
    });

    it('should handle . and .. in paths', () => {
      const result = PathSecurity.normalize('./src/../src/agent.ts', workspace);
      expect(result).toBe(path.join(workspace, 'src/agent.ts'));
    });

    it('should throw for .. that escapes workspace', () => {
      expect(() => {
        PathSecurity.normalize('../../../../../../etc/passwd', workspace);
      }).toThrow(PathSecurityError);
    });
  });

  describe('checkRestricted', () => {
    it('should allow normal paths', () => {
      const normalPath = path.join(workspace, 'src/agent.ts');
      expect(() => {
        PathSecurity.checkRestricted(normalPath);
      }).not.toThrow();
    });

    it('should reject .git directory', () => {
      const gitPath = path.join(workspace, '.git/config');
      expect(() => {
        PathSecurity.checkRestricted(gitPath);
      }).toThrow(PathSecurityError);
      expect(() => {
        PathSecurity.checkRestricted(gitPath);
      }).toThrow('Access denied');
    });

    it('should reject .claude directory', () => {
      const claudePath = path.join(workspace, '.claude/settings.json');
      expect(() => {
        PathSecurity.checkRestricted(claudePath);
      }).toThrow(PathSecurityError);
    });

    it('should reject node_modules directory', () => {
      const nmPath = path.join(workspace, 'node_modules/package/index.js');
      expect(() => {
        PathSecurity.checkRestricted(nmPath);
      }).toThrow(PathSecurityError);
    });

    it('should reject .env files', () => {
      const envPath = path.join(workspace, '.env');
      expect(() => {
        PathSecurity.checkRestricted(envPath);
      }).toThrow(PathSecurityError);
    });

    it('should reject .env.local files', () => {
      const envPath = path.join(workspace, '.env.local');
      expect(() => {
        PathSecurity.checkRestricted(envPath);
      }).toThrow(PathSecurityError);
    });
  });

  describe('checkTraversal', () => {
    it('should allow normal paths', () => {
      expect(() => {
        PathSecurity.checkTraversal('src/agent.ts');
      }).not.toThrow();
    });

    it('should reject paths with ..', () => {
      expect(() => {
        PathSecurity.checkTraversal('../../etc/passwd');
      }).toThrow(PathSecurityError);

      expect(() => {
        PathSecurity.checkTraversal('../../etc/passwd');
      }).toThrow('Path traversal not allowed');
    });

    it('should reject paths with .. in the middle', () => {
      expect(() => {
        PathSecurity.checkTraversal('src/../../../etc/passwd');
      }).toThrow(PathSecurityError);
    });
  });

  describe('isWithinWorkspace', () => {
    it('should return true for paths within workspace', () => {
      const insidePath = path.join(workspace, 'src/agent.ts');
      expect(PathSecurity.isWithinWorkspace(insidePath, workspace)).toBe(true);
    });

    it('should return false for paths outside workspace', () => {
      const outsidePath = '/etc/passwd';
      expect(PathSecurity.isWithinWorkspace(outsidePath, workspace)).toBe(false);
    });

    it('should handle workspace root itself', () => {
      expect(PathSecurity.isWithinWorkspace(workspace, workspace)).toBe(true);
    });
  });

  describe('isRestricted', () => {
    it('should return false for normal paths', () => {
      const normalPath = path.join(workspace, 'src/agent.ts');
      expect(PathSecurity.isRestricted(normalPath)).toBe(false);
    });

    it('should return true for restricted paths', () => {
      const gitPath = path.join(workspace, '.git/config');
      expect(PathSecurity.isRestricted(gitPath)).toBe(true);

      const envPath = path.join(workspace, '.env');
      expect(PathSecurity.isRestricted(envPath)).toBe(true);

      const nmPath = path.join(workspace, 'node_modules/pkg/index.js');
      expect(PathSecurity.isRestricted(nmPath)).toBe(true);
    });
  });

  describe('getRelativePath', () => {
    it('should return relative path from workspace', () => {
      const absolutePath = path.join(workspace, 'src/agent.ts');
      const result = PathSecurity.getRelativePath(absolutePath, workspace);
      expect(result).toBe('src/agent.ts');
    });

    it('should handle workspace root', () => {
      const result = PathSecurity.getRelativePath(workspace, workspace);
      expect(result).toBe('');
    });

    it('should handle nested paths', () => {
      const absolutePath = path.join(workspace, 'src/utils/helpers/index.ts');
      const result = PathSecurity.getRelativePath(absolutePath, workspace);
      expect(result).toBe('src/utils/helpers/index.ts');
    });
  });

  describe('PathSecurityError', () => {
    it('should create error with code', () => {
      const error = new PathSecurityError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('PathSecurityError');
    });

    it('should be instanceof Error', () => {
      const error = new PathSecurityError('Test', 'CODE');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof PathSecurityError).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle Windows-style paths on Windows', () => {
      if (process.platform === 'win32') {
        const winPath = 'src\\agent.ts';
        const result = PathSecurity.normalize(winPath, workspace);
        expect(result).toContain('agent.ts');
      }
    });

    it('should handle empty path components', () => {
      const result = PathSecurity.normalize('src//agent.ts', workspace);
      expect(result).toBe(path.join(workspace, 'src/agent.ts'));
    });

    it('should handle trailing slashes', () => {
      const result = PathSecurity.normalize('src/utils/', workspace);
      expect(result).toBe(path.join(workspace, 'src/utils'));
    });
  });
});
