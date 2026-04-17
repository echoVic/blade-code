/**
 * HTTP Hook 安全检查
 *
 * 防御要点:
 * 1. SSRF: 默认拒绝 loopback (127.0.0.1/::1/localhost) 和 RFC1918 私有 IP 段
 *    (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) 以及 link-local (169.254.0.0/16)
 * 2. TLS: 默认要求 https://
 * 3. allowedHosts: 显式允许的 hostname (精确 or *.domain.com 通配) 可以绕过上述限制
 *
 * 所有检查在请求发起前进行。
 */

import type { HttpHookPolicy } from './types/HookTypes.js';

export class HttpHookSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpHookSecurityError';
  }
}

/**
 * 验证 HTTP Hook URL 是否可达
 * 不通过时抛 HttpHookSecurityError
 */
export function validateHookUrl(url: string, policy: HttpHookPolicy = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpHookSecurityError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpHookSecurityError(
      `Only http/https supported, got: ${parsed.protocol}`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const inAllowlist = matchAllowedHosts(hostname, policy.allowedHosts);

  // allowedHosts 命中 → 绕过 HTTPS/loopback/private 检查
  if (inAllowlist) return;

  if (parsed.protocol === 'http:' && !policy.allowHttp) {
    throw new HttpHookSecurityError(
      `HTTP (non-TLS) blocked for ${hostname}; use https:// or add to allowedHosts`
    );
  }

  if (isLoopback(hostname) && !policy.allowLoopback) {
    throw new HttpHookSecurityError(
      `Loopback address blocked: ${hostname}; enable policy.allowLoopback or add to allowedHosts`
    );
  }

  if (isPrivateOrLinkLocal(hostname) && !policy.allowPrivateRanges) {
    throw new HttpHookSecurityError(
      `Private/link-local address blocked: ${hostname}; enable policy.allowPrivateRanges or add to allowedHosts`
    );
  }
}

function matchAllowedHosts(
  hostname: string,
  allowedHosts: string[] | undefined
): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  return allowedHosts.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === hostname) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return false;
  });
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  // IPv4 loopback: 127.0.0.0/8
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

function isPrivateOrLinkLocal(hostname: string): boolean {
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local, 包含云 metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 替换 headers 值中的 ${ENV_VAR}
 * 未定义的变量保留原字符串 (便于 debug)
 */
export function substituteEnvVars(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name) => {
      const envValue = process.env[name];
      return envValue ?? `\${${name}}`;
    });
  }
  return out;
}
