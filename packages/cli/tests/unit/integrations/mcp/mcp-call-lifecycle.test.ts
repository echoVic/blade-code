import { describe, expect, it } from 'vitest';
import {
  normalizeMcpCallLifecycle,
  normalizeMcpProgress,
} from '../../../../src/mcp/McpCallLifecycle.js';

describe('MCP call lifecycle policy', () => {
  it('uses bounded idle and hard total timeouts', () => {
    expect(normalizeMcpCallLifecycle({})).toEqual({
      totalTimeoutMs: 300_000,
      idleTimeoutMs: 60_000,
      maxProgressEvents: 128,
    });
    expect(
      normalizeMcpCallLifecycle({
        timeout: 10_000,
        idleTimeout: 2_000,
      })
    ).toEqual({
      totalTimeoutMs: 10_000,
      idleTimeoutMs: 2_000,
      maxProgressEvents: 128,
    });
  });

  it('rejects invalid timeout configuration', () => {
    expect(() => normalizeMcpCallLifecycle({ timeout: 999 })).toThrow('MCP timeout');
    expect(() =>
      normalizeMcpCallLifecycle({
        timeout: 2_000,
        idleTimeout: 3_000,
      })
    ).toThrow('must not exceed timeout');
  });

  it('normalizes monotonic progress and bounds untrusted messages', () => {
    const policy = normalizeMcpCallLifecycle({});
    const state = { count: 0 };
    expect(
      normalizeMcpProgress(
        {
          progress: 1,
          total: 4,
          message: `phase\0-${'x'.repeat(2_000)}`,
        },
        state,
        policy
      )
    ).toEqual({
      progress: 1,
      total: 4,
      message: `phase-${'x'.repeat(994)}`,
    });
    expect(
      normalizeMcpProgress({ progress: 0, total: 4 }, state, policy)
    ).toBeUndefined();
    expect(normalizeMcpProgress({ progress: 2, total: 4 }, state, policy)).toEqual({
      progress: 2,
      total: 4,
      message: 'MCP progress 50%',
    });
  });

  it('ignores invalid and excessive progress notifications', () => {
    const policy = {
      ...normalizeMcpCallLifecycle({}),
      maxProgressEvents: 1,
    };
    expect(
      normalizeMcpProgress({ progress: Number.NaN }, { count: 0 }, policy)
    ).toBeUndefined();
    expect(
      normalizeMcpProgress({ progress: 1, total: 0 }, { count: 0 }, policy)
    ).toBeUndefined();
    expect(normalizeMcpProgress({ progress: 1 }, { count: 1 }, policy)).toBeUndefined();
  });
});
