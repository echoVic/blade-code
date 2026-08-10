import { describe, expect, it, vi } from 'vitest';
import type { McpClient } from '../../../../src/mcp/McpClient.js';
import { HealthMonitor, HealthStatus } from '../../../../src/mcp/HealthMonitor.js';
import { McpConnectionStatus } from '../../../../src/mcp/types.js';

function createClient() {
  return {
    connectionStatus: McpConnectionStatus.CONNECTED,
    ping: vi.fn().mockResolvedValue(undefined),
    requestRecovery: vi.fn(),
  };
}

describe('MCP health monitor', () => {
  it('uses a real bounded MCP ping instead of cached catalog state', async () => {
    const client = createClient();
    const monitor = new HealthMonitor(client as unknown as McpClient, {
      enabled: true,
      timeout: 25,
      failureThreshold: 2,
    });

    await expect(monitor.checkNow()).resolves.toMatchObject({
      status: HealthStatus.HEALTHY,
      consecutiveFailures: 0,
    });
    expect(client.ping).toHaveBeenCalledWith(25);
    expect(client.requestRecovery).not.toHaveBeenCalled();
  });

  it('delegates threshold failures to the single connection recovery state machine', async () => {
    const client = createClient();
    client.ping.mockRejectedValue(new Error('ping timeout'));
    const monitor = new HealthMonitor(client as unknown as McpClient, {
      enabled: true,
      timeout: 25,
      failureThreshold: 2,
    });

    await expect(monitor.checkNow()).resolves.toMatchObject({
      status: HealthStatus.DEGRADED,
      consecutiveFailures: 1,
    });
    expect(client.requestRecovery).not.toHaveBeenCalled();

    await expect(monitor.checkNow()).resolves.toMatchObject({
      status: HealthStatus.UNHEALTHY,
      consecutiveFailures: 2,
    });
    expect(client.requestRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'ping timeout' }),
      'health_check'
    );
  });

  it.each([
    [{ interval: 0 }, 'interval'],
    [{ timeout: 0 }, 'timeout'],
    [{ failureThreshold: 0 }, 'failureThreshold'],
    [{ enabled: 'yes' }, 'enabled'],
  ])('rejects unsafe health configuration %#', (config, expected) => {
    const client = createClient();
    expect(
      () => new HealthMonitor(client as unknown as McpClient, config as never)
    ).toThrow(expected);
  });
});
