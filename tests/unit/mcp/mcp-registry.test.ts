/**
 * McpRegistry 单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../../src/mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../../src/mcp/types.js';

// Mock McpClient
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockListTools = vi.fn();

vi.mock('../../../src/mcp/McpClient.js', () => {
  return {
    McpClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      listTools: mockListTools,
      on: vi.fn(),
      off: vi.fn(),
    })),
  };
});

describe('McpRegistry', () => {
  let registry: McpRegistry;

  beforeEach(() => {
    // 重置单例 (需要 hack private 属性)
    (McpRegistry as any).instance = null;
    registry = McpRegistry.getInstance();

    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockListTools.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue([]);
  });

  it('应该是单例模式', () => {
    const instance1 = McpRegistry.getInstance();
    const instance2 = McpRegistry.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('应该能够注册服务器', async () => {
    const config = {
      type: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
    };

    await registry.registerServer('test-server', config);

    // API 修正：使用 getServerStatus 获取服务器信息
    const server = registry.getServerStatus('test-server');
    expect(server).toBeDefined();
    expect(server?.config).toEqual(config);
    expect(server?.status).toBe(McpConnectionStatus.CONNECTING); // 初始连接中
  });

  it('重复注册应该抛出错误', async () => {
    const config = { type: 'stdio' as const, command: 'node', args: [] };
    await registry.registerServer('test-server', config);

    await expect(registry.registerServer('test-server', config)).rejects.toThrow(
      'MCP服务器 "test-server" 已经注册'
    );
  });

  it('注销服务器应该断开连接', async () => {
    const config = { type: 'stdio' as const, command: 'node', args: [] };
    await registry.registerServer('test-server', config);

    await registry.unregisterServer('test-server');

    expect(mockDisconnect).toHaveBeenCalled();
    expect(registry.getServerStatus('test-server')).toBeNull();
  });

  it('应该能列出所有服务器', async () => {
    await registry.registerServer('s1', {
      type: 'stdio' as const,
      command: 'a',
      args: [],
    });
    await registry.registerServer('s2', {
      type: 'stdio' as const,
      command: 'b',
      args: [],
    });

    const servers = registry.getAllServers();
    expect(servers.size).toBe(2);
    expect(
      Array.from(servers.values())
        .map((s) => s.config.command)
        .sort()
    ).toEqual(['a', 'b']);
  });
});
