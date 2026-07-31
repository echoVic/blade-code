import { describe, it, expect } from 'vitest';

describe('敏感文件检测', () => {
  const sensitivePatterns = [
    /\.env$/,
    /\.env\..+$/,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
    /id_rsa$/,
    /id_dsa$/,
    /id_ecdsa$/,
    /id_ed25519$/,
    /\.ssh\/config$/,
    /\.gitconfig$/,
    /\.npmrc$/,
    /\.pypirc$/,
    /credentials\.json$/,
    /secrets\.json$/,
    /config\.json$/,
    /\.aws\/credentials$/,
    /\.docker\/config\.json$/,
    /kubeconfig$/,
    /\.kube\/config$/,
  ];

  const isSensitiveFile = (filePath: string): boolean => {
    return sensitivePatterns.some((pattern) => pattern.test(filePath));
  };

  describe('环境变量文件', () => {
    it('应该检测 .env 文件', () => {
      expect(isSensitiveFile('.env')).toBe(true);
      expect(isSensitiveFile('.env.local')).toBe(true);
      expect(isSensitiveFile('.env.production')).toBe(true);
      expect(isSensitiveFile('.env.development')).toBe(true);
    });

    it('应该允许非敏感的 env 相关文件', () => {
      expect(isSensitiveFile('.env.example')).toBe(true);
      expect(isSensitiveFile('env.ts')).toBe(false);
    });
  });

  describe('密钥和证书文件', () => {
    it('应该检测私钥文件', () => {
      expect(isSensitiveFile('server.key')).toBe(true);
      expect(isSensitiveFile('private.pem')).toBe(true);
      expect(isSensitiveFile('certificate.p12')).toBe(true);
      expect(isSensitiveFile('keystore.pfx')).toBe(true);
    });

    it('应该检测 SSH 密钥', () => {
      expect(isSensitiveFile('id_rsa')).toBe(true);
      expect(isSensitiveFile('id_dsa')).toBe(true);
      expect(isSensitiveFile('id_ecdsa')).toBe(true);
      expect(isSensitiveFile('id_ed25519')).toBe(true);
      expect(isSensitiveFile('.ssh/config')).toBe(true);
    });
  });

  describe('配置文件', () => {
    it('应该检测包管理器配置', () => {
      expect(isSensitiveFile('.npmrc')).toBe(true);
      expect(isSensitiveFile('.pypirc')).toBe(true);
    });

    it('应该检测云服务凭证', () => {
      expect(isSensitiveFile('.aws/credentials')).toBe(true);
      expect(isSensitiveFile('.docker/config.json')).toBe(true);
      expect(isSensitiveFile('.kube/config')).toBe(true);
      expect(isSensitiveFile('kubeconfig')).toBe(true);
    });

    it('应该检测通用凭证文件', () => {
      expect(isSensitiveFile('credentials.json')).toBe(true);
      expect(isSensitiveFile('secrets.json')).toBe(true);
    });
  });

  describe('敏感内容检测', () => {
    const sensitiveContentPatterns = [
      /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/i,
      /secret[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/i,
      /password\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i,
      /token\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{20,}['"]?/i,
      /bearer\s+[a-zA-Z0-9_.-]{20,}/i,
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
      /-----BEGIN\s+CERTIFICATE-----/,
      /aws_access_key_id\s*=\s*[A-Z0-9]{20}/i,
      /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/i,
    ];

    const containsSensitiveContent = (content: string): boolean => {
      return sensitiveContentPatterns.some((pattern) => pattern.test(content));
    };

    it('应该检测 API 密钥', () => {
      expect(containsSensitiveContent('API_KEY=sk-1234567890abcdefghij')).toBe(true);
      expect(containsSensitiveContent('api-key: "abcdefghijklmnopqrstuvwxyz"')).toBe(
        true
      );
    });

    it('应该检测密码', () => {
      expect(containsSensitiveContent('password=MySecretPassword123')).toBe(true);
      expect(containsSensitiveContent('PASSWORD: "super_secret_pass"')).toBe(true);
    });

    it('应该检测 Bearer Token', () => {
      expect(
        containsSensitiveContent(
          'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
        )
      ).toBe(true);
    });

    it('应该检测私钥内容', () => {
      expect(containsSensitiveContent('-----BEGIN PRIVATE KEY-----')).toBe(true);
      expect(containsSensitiveContent('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    });

    it('应该检测 AWS 凭证', () => {
      expect(containsSensitiveContent('aws_access_key_id = AKIAIOSFODNN7EXAMPLE')).toBe(
        true
      );
      expect(
        containsSensitiveContent(
          'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        )
      ).toBe(true);
    });

    it('应该允许非敏感内容', () => {
      expect(containsSensitiveContent('const name = "John"')).toBe(false);
      expect(containsSensitiveContent('export function hello() {}')).toBe(false);
    });
  });

  describe('Git 忽略检查', () => {
    const gitignorePatterns = [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa',
      'id_dsa',
      '.aws/',
      '.docker/',
      'secrets/',
      'credentials/',
    ];

    it('应该建议将敏感文件添加到 .gitignore', () => {
      const sensitiveFiles = [
        '.env',
        '.env.local',
        'private.key',
        'server.pem',
        'id_rsa',
      ];

      for (const file of sensitiveFiles) {
        const shouldBeIgnored = gitignorePatterns.some((pattern) => {
          if (pattern.endsWith('/')) {
            return file.startsWith(pattern.slice(0, -1));
          }
          if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
            return regex.test(file);
          }
          return file === pattern || file.startsWith(pattern + '.');
        });
        expect(shouldBeIgnored).toBe(true);
      }
    });
  });
});
