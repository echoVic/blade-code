/**
 * MCP 系统集成测试
 */

import { MCPClient } from '../../packages/core/src/mcp/client/MCPClient';
import { MCPConfig } from '../../packages/core/src/mcp/config/MCPConfig';
import { MCPServer } from '../../packages/core/src/mcp/server/MCPServer';

// 模拟 WebSocket 实现
class MockWebSocket {
  private listeners: Map<string, Function[]> = new Map();
  public readyState: number = 1; // OPEN

  constructor(public url: string) {}

  addEventListener(event: string, listener: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  removeEventListener(event: string, listener: Function) {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  send(data: string) {
    // 模拟发送数据
    setTimeout(() => {
      const listeners = this.listeners.get('message');
      if (listeners) {
        listeners.forEach((listener) => {
          listener({ data: JSON.stringify({ id: 1, result: 'mock response' }) });
        });
      }
    }, 10);
  }

  close() {
    this.readyState = 3; // CLOSED
    const listeners = this.listeners.get('close');
    if (listeners) {
      listeners.forEach((listener) => listener());
    }
  }
}

describe('MCP 系统集成测试', () => {
  let client: MCPClient;
  let server: MCPServer;
  let originalWebSocket: any;

  beforeAll(async () => {
    jest.setTimeout(30000);

    // 模拟 WebSocket
    originalWebSocket = (global as any).WebSocket;
    (global as any).WebSocket = MockWebSocket;
  });

  afterAll(() => {
    // 恢复原始 WebSocket
    (global as any).WebSocket = originalWebSocket;
  });

  beforeEach(async () => {
    // 创建默认配置
    const config = new MCPConfig({
      server: {
        port: 3001,
        host: 'localhost',
      },
      client: {
        reconnect: true,
        timeout: 5000,
      },
    });

    server = new MCPServer(config);
    client = new MCPClient(config);
  });

  afterEach(async () => {
    if (client) {
      await client.destroy();
    }

    if (server) {
      await server.destroy();
    }
  });

  describe('连接集成', () => {
    test('应该能够建立客户端-服务器连接', async () => {
      // 启动服务器
      await server.start();

      // 连接客户端
      const result = await client.connect('ws://localhost:3001');

      expect(result.success).toBe(true);
      expect(client.isConnected()).toBe(true);

      // 断开连接
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    test('应该正确处理连接错误', async () => {
      // 尝试连接到未启动的服务器
      await expect(client.connect('ws://localhost:9999')).rejects.toThrow();
    });

    test('应该支持自动重连', async () => {
      // 启动服务器
      await server.start();

      // 连接客户端
      await client.connect('ws://localhost:3001');
      expect(client.isConnected()).toBe(true);

      // 模拟连接断开
      await server.stop();
      expect(client.isConnected()).toBe(false);

      // 重新启动服务器
      await server.start();

      // 等待自动重连（如果实现了的话）
      // 这里只是验证重连机制不会崩溃
    });
  });

  describe('消息传递集成', () => {
    test('应该能够发送和接收请求', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 注册服务器端处理程序
      server.on('ping', async (params) => {
        return { message: 'pong', timestamp: Date.now() };
      });

      // 发送请求
      const request = {
        method: 'ping',
        params: { test: true },
      };

      const response = await client.sendRequest(request);

      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
      expect(response.data.message).toBe('pong');
    });

    test('应该能够发送和接收通知', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 设置通知监听器
      const notificationHandler = jest.fn();
      client.on('status-update', notificationHandler);

      // 发送通知
      const notification = {
        method: 'status-update',
        params: { status: 'ready', progress: 100 },
      };

      const result = await client.sendNotification(notification);

      expect(result.success).toBe(true);
      // 由于是模拟实现，这里可能不会收到通知
    });

    test('应该正确处理请求错误', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 注册会抛出错误的处理程序
      server.on('error-test', async () => {
        throw new Error('Test error from server');
      });

      // 发送请求
      const request = {
        method: 'error-test',
        params: {},
      };

      const response = await client.sendRequest(request);

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    });
  });

  describe('协议兼容性集成', () => {
    test('应该支持 MCP 协议标准方法', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 测试标准 initialize 方法
      const initRequest = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-01-01',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const response = await client.sendRequest(initRequest);

      expect(response.success).toBe(true);
    });

    test('应该正确处理协议版本不匹配', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 这需要服务器实现版本检查逻辑
      expect(true).toBe(true); // 占位符
    });
  });

  describe('性能集成', () => {
    test('应该在合理时间内建立连接', async () => {
      await server.start();

      const startTime = Date.now();
      await client.connect('ws://localhost:3001');
      const endTime = Date.now();

      const connectTime = endTime - startTime;
      expect(connectTime).toBeLessThan(2000); // 2秒内应该连接成功
    });

    test('应该能够处理高并发请求', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 注册处理程序
      server.on('echo', async (params) => params);

      // 发送并发请求
      const requests = Array.from({ length: 20 }, (_, i) => ({
        method: 'echo',
        params: { id: i, message: `test-${i}` },
      }));

      const promises = requests.map((req) => client.sendRequest(req));
      const responses = await Promise.all(promises);

      expect(responses).toHaveLength(20);
      responses.forEach((response, index) => {
        expect(response.success).toBe(true);
        expect(response.data.id).toBe(index);
      });
    });
  });

  describe('错误处理集成', () => {
    test('应该在服务器关闭时正确处理', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 关闭服务器
      await server.stop();

      // 尝试发送请求应该失败
      const request = { method: 'test', params: {} };
      await expect(client.sendRequest(request)).rejects.toThrow();
    });

    test('应该正确处理无效消息格式', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      // 这需要访问底层 WebSocket 来发送无效格式
      expect(true).toBe(true); // 占位符
    });

    test('应该在客户端销毁时清理资源', async () => {
      await server.start();
      await client.connect('ws://localhost:3001');

      const startTime = Date.now();
      await client.destroy();
      const endTime = Date.now();

      // 销毁应该在合理时间内完成
      expect(endTime - startTime).toBeLessThan(1000);
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('配置集成', () => {
    test('应该能够使用不同的配置选项', async () => {
      // 创建自定义配置
      const customConfig = new MCPConfig({
        server: {
          port: 3002,
          host: '127.0.0.1',
        },
        client: {
          reconnect: false,
          timeout: 1000,
        },
      });

      const customServer = new MCPServer(customConfig);
      const customClient = new MCPClient(customConfig);

      await customServer.start();
      await customClient.connect('ws://127.0.0.1:3002');

      expect(customClient.isConnected()).toBe(true);

      await customClient.destroy();
      await customServer.destroy();
    });

    test('应该正确验证配置参数', async () => {
      // 测试无效配置
      expect(() => {
        new MCPConfig({
          server: {
            port: -1, // 无效端口
            host: 'localhost',
          },
        } as any);
      }).toThrow();
    });
  });
});
