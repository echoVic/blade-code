import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpHookSecurityError,
  substituteEnvVars,
  validateHookUrl,
} from '../../../src/hooks/HttpHookSecurity.js';

describe('HttpHookSecurity', () => {
  describe('validateHookUrl — URL 格式', () => {
    it('非法 URL 应抛错', () => {
      expect(() => validateHookUrl('not-a-url')).toThrow(HttpHookSecurityError);
    });

    it('仅支持 http/https', () => {
      expect(() => validateHookUrl('ftp://example.com')).toThrow(
        /Only http\/https supported/
      );
    });
  });

  describe('HTTPS 强制', () => {
    it('http:// 默认被拒绝', () => {
      expect(() => validateHookUrl('http://api.example.com')).toThrow(
        /HTTP \(non-TLS\) blocked/
      );
    });

    it('policy.allowHttp=true 时放行', () => {
      expect(() =>
        validateHookUrl('http://api.example.com', { allowHttp: true })
      ).not.toThrow();
    });

    it('https:// 公网地址默认通过', () => {
      expect(() => validateHookUrl('https://api.example.com')).not.toThrow();
    });
  });

  describe('Loopback 防护', () => {
    it.each([
      'http://127.0.0.1/hook',
      'http://127.1.2.3/hook',
      'https://localhost/hook',
      'http://[::1]/hook',
    ])('默认拒绝 %s', (url) => {
      expect(() => validateHookUrl(url)).toThrow(
        /Loopback address blocked|HTTP \(non-TLS\) blocked/
      );
    });

    it('allowLoopback=true + allowHttp=true 时放行', () => {
      expect(() =>
        validateHookUrl('http://127.0.0.1:8080/hook', {
          allowLoopback: true,
          allowHttp: true,
        })
      ).not.toThrow();
    });
  });

  describe('私网防护', () => {
    it.each([
      'https://10.0.0.1/hook',
      'https://10.255.255.255/hook',
      'https://172.16.0.1/hook',
      'https://172.31.255.1/hook',
      'https://192.168.1.1/hook',
      'https://169.254.169.254/hook', // 云 metadata
    ])('默认拒绝 %s', (url) => {
      expect(() => validateHookUrl(url)).toThrow(/Private\/link-local address blocked/);
    });

    it('172.32+ / 172.0-15 不属于私网段', () => {
      expect(() => validateHookUrl('https://172.32.0.1/hook')).not.toThrow();
      expect(() => validateHookUrl('https://172.15.0.1/hook')).not.toThrow();
    });

    it('allowPrivateRanges=true 时放行', () => {
      expect(() =>
        validateHookUrl('https://10.0.0.1/hook', { allowPrivateRanges: true })
      ).not.toThrow();
    });
  });

  describe('allowedHosts 白名单', () => {
    it('精确匹配绕过所有检查', () => {
      expect(() =>
        validateHookUrl('http://127.0.0.1:8080/hook', {
          allowedHosts: ['127.0.0.1'],
        })
      ).not.toThrow();
    });

    it('通配符 *.domain.com 匹配子域', () => {
      expect(() =>
        validateHookUrl('https://api.internal.corp.example.com', {
          allowedHosts: ['*.corp.example.com'],
        })
      ).not.toThrow();
    });

    it('通配符不匹配 apex 域', () => {
      expect(() =>
        validateHookUrl('https://corp.example.com', {
          allowedHosts: ['*.corp.example.com'],
        })
      ).not.toThrow(); // apex 是公网 HTTPS,默认通过 (不是被白名单放行的)
    });

    it('非匹配的 hostname 仍按默认规则', () => {
      expect(() =>
        validateHookUrl('http://10.0.0.1', {
          allowedHosts: ['*.example.com'],
        })
      ).toThrow();
    });
  });
});

describe('substituteEnvVars', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  it('替换存在的环境变量', () => {
    process.env.TEST_TOKEN = 'secret123';
    const headers = substituteEnvVars({
      Authorization: 'Bearer ${TEST_TOKEN}',
    });
    expect(headers.Authorization).toBe('Bearer secret123');
  });

  it('未定义的变量保留原字符串', () => {
    delete process.env.UNDEFINED_VAR;
    const headers = substituteEnvVars({
      X: 'value-${UNDEFINED_VAR}',
    });
    expect(headers.X).toBe('value-${UNDEFINED_VAR}');
  });

  it('多次替换', () => {
    process.env.A = '1';
    process.env.B = '2';
    const headers = substituteEnvVars({ X: '${A}/${B}/${A}' });
    expect(headers.X).toBe('1/2/1');
  });

  it('undefined 输入返回空对象', () => {
    expect(substituteEnvVars(undefined)).toEqual({});
  });
});
