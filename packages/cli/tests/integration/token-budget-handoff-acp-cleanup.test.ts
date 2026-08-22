import { describe, expect, it, vi } from 'vitest';
import {
  resolveTokenBudgetAcpCleanupProbeTimeouts,
  runTokenBudgetAcpCleanupProbe,
} from '../support/tokenBudgetHandoffAcpDriver.js';

vi.unmock('child_process');
vi.unmock('node:child_process');
vi.unmock('http');
vi.unmock('node:http');

const CLEANUP_PROBE_TEST_TIMEOUT_MS =
  resolveTokenBudgetAcpCleanupProbeTimeouts().processTimeoutMs + 20_000;

describe('token-budget ACP process cleanup', () => {
  it(
    'lets the ACP child cancel and close before its parent process timeout',
    async () => {
      await expect(runTokenBudgetAcpCleanupProbe()).resolves.toEqual({
        timedOut: true,
        cancelled: true,
        closed: true,
        naturalExit: true,
      });
    },
    CLEANUP_PROBE_TEST_TIMEOUT_MS
  );
});
