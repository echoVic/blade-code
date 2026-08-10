import { describe, expect, it } from 'vitest';
import {
  getMcpRecoveryDelay,
  isMcpSessionExpiredError,
  isTerminalMcpTransportError,
  MAX_MCP_CONNECTION_ERROR_BYTES,
  normalizeMcpRecoveryPolicy,
  sanitizeMcpConnectionError,
} from '../../../../src/mcp/McpConnectionRecovery.js';

describe('MCP connection recovery policy', () => {
  it('uses bounded production defaults', () => {
    expect(normalizeMcpRecoveryPolicy({})).toEqual({
      enabled: true,
      maxAttempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
      terminalErrorThreshold: 3,
    });
  });

  it('normalizes explicit retry policy and caps exponential delays', () => {
    const policy = normalizeMcpRecoveryPolicy({
      recovery: {
        maxAttempts: 4,
        initialDelayMs: 20,
        maxDelayMs: 50,
        jitterRatio: 0,
        terminalErrorThreshold: 1,
      },
    });

    expect([1, 2, 3, 4].map((attempt) => getMcpRecoveryDelay(policy, attempt))).toEqual(
      [20, 40, 50, 50]
    );
  });

  it('applies symmetric bounded jitter', () => {
    const policy = normalizeMcpRecoveryPolicy({
      recovery: {
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        jitterRatio: 0.2,
      },
    });

    expect(getMcpRecoveryDelay(policy, 1, () => 0)).toBe(800);
    expect(getMcpRecoveryDelay(policy, 1, () => 0.5)).toBe(1_000);
    expect(getMcpRecoveryDelay(policy, 1, () => 1)).toBe(1_200);
  });

  it.each([
    [{ recovery: { maxAttempts: 21 } }, 'maxAttempts'],
    [{ recovery: { initialDelayMs: 0 } }, 'initialDelayMs'],
    [{ recovery: { initialDelayMs: 1_000, maxDelayMs: 999 } }, 'maxDelayMs'],
    [{ recovery: { jitterRatio: 2 } }, 'jitterRatio'],
    [{ recovery: { terminalErrorThreshold: 0 } }, 'terminalErrorThreshold'],
  ])('rejects unsafe recovery configuration %#', (config, expected) => {
    expect(() => normalizeMcpRecoveryPolicy(config)).toThrow(expected);
  });

  it('classifies terminal transport and expired-session failures', () => {
    expect(isTerminalMcpTransportError(new Error('read ECONNRESET'))).toBe(true);
    expect(
      isTerminalMcpTransportError(
        new Error('Maximum reconnection attempts (2) exceeded.')
      )
    ).toBe(true);
    expect(isTerminalMcpTransportError(new Error('Invalid prompt argument'))).toBe(
      false
    );
    expect(
      isMcpSessionExpiredError(new Error('HTTP 404: JSON-RPC -32001 session not found'))
    ).toBe(true);
  });

  it('redacts credentials and URLs from bounded lifecycle errors', () => {
    const value = sanitizeMcpConnectionError(
      new Error(
        `GET https://example.test/private?token=secret Bearer token-value ` +
          `sk-${'x'.repeat(40)} ${'你'.repeat(600)}`
      )
    );

    expect(value).toContain('[redacted-url]');
    expect(value).toContain('Bearer [redacted]');
    expect(value).not.toContain('token-value');
    expect(value).not.toContain('sk-');
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(
      MAX_MCP_CONNECTION_ERROR_BYTES
    );
  });
});
