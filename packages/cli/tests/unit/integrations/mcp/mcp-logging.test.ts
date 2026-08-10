import { describe, expect, it } from 'vitest';
import {
  isMcpLogLevelEnabled,
  MAX_MCP_LOG_MESSAGE_BYTES,
  MAX_MCP_LOG_PROJECTED_BYTES,
  normalizeMcpLogEntry,
  normalizeMcpLoggingPolicy,
} from '../../../../src/mcp/McpLogging.js';

describe('MCP logging safety', () => {
  it('normalizes the default policy and rejects malformed configuration', () => {
    expect(normalizeMcpLoggingPolicy({})).toEqual({
      enabled: true,
      level: 'warning',
    });
    expect(
      normalizeMcpLoggingPolicy({
        logging: {
          enabled: false,
          level: 'critical',
        },
      })
    ).toEqual({
      enabled: false,
      level: 'critical',
    });
    expect(() =>
      normalizeMcpLoggingPolicy({
        logging: { level: 'verbose' as 'warning' },
      })
    ).toThrow('MCP logging level');
    expect(() =>
      normalizeMcpLoggingPolicy({
        logging: null as never,
      })
    ).toThrow('must be an object');
  });

  it('uses the MCP severity ordering for local filtering', () => {
    expect(isMcpLogLevelEnabled('debug', 'warning')).toBe(false);
    expect(isMcpLogLevelEnabled('warning', 'warning')).toBe(true);
    expect(isMcpLogLevelEnabled('emergency', 'warning')).toBe(true);
  });

  it('redacts nested secrets and bounds untrusted structured data', () => {
    const entry = normalizeMcpLogEntry(
      {
        level: 'error',
        logger: `fixture\0-${'l'.repeat(1_000)}`,
        data: {
          marker: 'SAFE_LOG_MARKER',
          accessToken: 'private-token',
          password: 'private-password',
          _meta: { injected: 'RAW_META_SECRET' },
          endpoint: 'https://example.test/private?token=secret',
          authorization: `Bearer ${'x'.repeat(100)}`,
          apiKey: `sk-${'y'.repeat(100)}`,
          large: 'z'.repeat(100_000),
        },
      },
      { now: 123 }
    );

    expect(entry.level).toBe('error');
    expect(entry.logger).not.toContain('\0');
    expect(entry.logger?.length).toBeLessThan(300);
    expect(entry.message).toContain('SAFE_LOG_MARKER');
    expect(entry.message).toContain('[redacted]');
    expect(entry.message).toContain('[redacted-url]');
    expect(entry.message).not.toContain('private-token');
    expect(entry.message).not.toContain('private-password');
    expect(entry.message).not.toContain('RAW_META_SECRET');
    expect(entry.message).not.toContain('sk-');
    expect(Buffer.byteLength(entry.message)).toBeLessThanOrEqual(
      MAX_MCP_LOG_MESSAGE_BYTES
    );
    expect(entry.projectedBytes).toBeLessThanOrEqual(MAX_MCP_LOG_PROJECTED_BYTES);
    expect(entry.dataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.truncated).toBe(true);
    expect(entry.timestamp).toBe(123);
  });

  it('hides all server-controlled details for remote ACP sessions', () => {
    const entry = normalizeMcpLogEntry(
      {
        level: 'warning',
        logger: '/private/host/logger',
        data: {
          path: '/private/host/workspace/secret.ts',
          marker: 'HOST_DETAIL_MARKER',
        },
      },
      {
        exposeDetails: false,
        now: 456,
      }
    );

    expect(entry.logger).toBeUndefined();
    expect(entry.message).toMatch(/^\[MCP log details omitted; sha256=[a-f0-9]{64}\]$/);
    expect(entry.message).not.toContain('HOST_DETAIL_MARKER');
    expect(entry.message).not.toContain('/private/host');
    expect(entry.detailsOmitted).toBe(true);
  });

  it('handles circular test inputs without throwing', () => {
    const data: Record<string, unknown> = { marker: 'cycle' };
    data.self = data;
    const entry = normalizeMcpLogEntry({
      level: 'notice',
      data,
    });

    expect(entry.message).toContain('[circular]');
    expect(entry.truncated).toBe(true);
  });
});
