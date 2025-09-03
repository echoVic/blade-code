/**
 * MCPComponent 单元测试
 */

import { MCPComponent } from '../MCPComponent.js';
import { Agent } from '../Agent.js';
import { MCPClient } from '../../mcp/client/MCPClient.js';

// Mock Agent
const mockAgent = {
  getConfig: jest.fn().mockReturnValue({
    mcp: {
      enabled: true,
      serverUrl: 'ws://localhost:3000',
      reconnect: true,
      timeout: 30000
    }
  }),
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }),
  getContext: jest.fn().mockReturnValue({
    sessionId: 'test-session-123'
  })
};

// Mock MCP Client
const mockMCPClient = {
  connect: jest.fn().mockResolvedValue({
    success: true,
    clientId: 'client-123'
  }),
  disconnect: jest.fn().mockResolvedValue({
    success: true
  }),
  sendRequest: jest.fn().mockResolvedValue({
    success: true,
    data: { result: 'test response' }
  }),
  sendNotification: jest.fn().mockResolvedValue({
    success: true,
    notificationId: 'not-456'
  }),
  isConnected: jest.fn().mockReturnValue(true),
  on: jest.fn(),
  off: jest.fn(),
  destroy: jest.fn()
};

jest.mock('../../mcp/client/MCPClient.js', () => {
  return {
    MCPClient: jest.fn().mockImplementation(() => mockMCPClient)
  };
});

describe('MCPComponent', () => {
  let mcpComponent: MCPComponent;
  
  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();
    
    // 创建新的 MCPComponent 实例
    mcpComponent = new MCPComponent(mockAgent as unknown as Agent);
  });
  
  afterEach(() => {
    // 销毁 mcpComponent 实例
    if (mcpComponent) {
      mcpComponent.destroy();
    }
  });
  
  describe('初始化', () => {
    test('应该成功创建 MCPComponent 实例', () => {
      expect(mcpComponent).toBeInstanceOf(MCPComponent);
    });
    
    test('应该能够正确初始化 MCPClient', async () => {
      await mcpComponent.initialize();
      
      expect(MCPClient).toHaveBeenCalled();
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
    
    test('应该正确设置状态', async () => {
      expect(mcpComponent.isInitialized()).toBe(false);
      
      await mcpComponent.initialize();
      
      expect(mcpComponent.isInitialized()).toBe(true);
    });
    
    test('应该在 MCP 被禁用时不初始化客户端', async () => {
      mockAgent.getConfig.mockReturnValueOnce({
        mcp: {
          enabled: false,
          serverUrl: 'ws://localhost:3000'
        }
      });
      
      await mcpComponent.initialize();
      
      expect(MCPClient).not.toHaveBeenCalled();
      expect(mcpComponent.isInitialized()).toBe(true); // 仍然标记为已初始化
    });
    
    test('应该在初始化失败时正确处理', async () => {
      (MCPClient as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Init Error');
      });
      
      await expect(mcpComponent.initialize()).rejects.toThrow('Init Error');
      expect(mcpComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('连接管理', () => {
    beforeEach(async () => {
      await mcpComponent.initialize();
    });
    
    test('应该能够连接到 MCP 服务器', async () => {
      const result = await mcpComponent.connect('ws://localhost:3001');
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.clientId).toBe('client-123');
      expect(mockMCPClient.connect).toHaveBeenCalledWith('ws://localhost:3001');
    });
    
    test('应该使用配置的服务器 URL 连接', async () => {
      const result = await mcpComponent.connect();
      
      expect(result).toBeDefined();
      expect(mockMCPClient.connect).toHaveBeenCalledWith('ws://localhost:3000');
    });
    
    test('应该能够断开连接', async () => {
      const result = await mcpComponent.disconnect();
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(mockMCPClient.disconnect).toHaveBeenCalled();
    });
    
    test('应该检查连接状态', () => {
      const isConnected = mcpComponent.isConnected();
      
      expect(isConnected).toBe(true);
      expect(mockMCPClient.isConnected).toHaveBeenCalled();
    });
  });
  
  describe('消息处理', () => {
    beforeEach(async () => {
      await mcpComponent.initialize();
    });
    
    test('应该能够发送请求', async () => {
      const request = {
        method: 'ping',
        params: {}
      };
      
      const result = await mcpComponent.sendRequest(request);
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.data.result).toBe('test response');
      expect(mockMCPClient.sendRequest).toHaveBeenCalledWith(request);
    });
    
    test('应该能够发送通知', async () => {
      const notification = {
        method: 'status-update',
        params: { status: 'ready' }
      };
      
      const result = await mcpComponent.sendNotification(notification);
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.notificationId).toBe('not-456');
      expect(mockMCPClient.sendNotification).toHaveBeenCalledWith(notification);
    });
    
    test('应该在未连接时拒绝发送消息', async () => {
      mockMCPClient.isConnected.mockReturnValueOnce(false);
      
      await expect(mcpComponent.sendRequest({ method: 'test' }))
        .rejects.toThrow('MCP client not connected');
      
      await expect(mcpComponent.sendNotification({ method: 'test' }))
        .rejects.toThrow('MCP client not connected');
    });
  });
  
  describe('事件处理', () => {
    beforeEach(async () => {
      await mcpComponent.initialize();
    });
    
    test('应该能够订阅事件', () => {
      const handler = jest.fn();
      mcpComponent.on('message', handler);
      
      expect(mockMCPClient.on).toHaveBeenCalledWith('message', handler);
    });
    
    test('应该能够取消订阅事件', () => {
      const handler = jest.fn();
      mcpComponent.off('message', handler);
      
      expect(mockMCPClient.off).toHaveBeenCalledWith('message', handler);
    });
  });
  
  describe('销毁', () => {
    beforeEach(async () => {
      await mcpComponent.initialize();
    });
    
    test('应该正确销毁 MCPComponent', async () => {
      await mcpComponent.destroy();
      
      expect(mockMCPClient.destroy).toHaveBeenCalled();
      expect(mcpComponent.isInitialized()).toBe(false);
    });
    
    test('应该能够多次安全调用销毁', async () => {
      await mcpComponent.destroy();
      await mcpComponent.destroy(); // 第二次调用
      
      // 应该不会出错，且 destroy 只调用一次
      expect(mockMCPClient.destroy).toHaveBeenCalledTimes(1);
      expect(mcpComponent.isInitialized()).toBe(false);
    });
    
    test('应该在未初始化时安全销毁', async () => {
      const newComponent = new MCPComponent(mockAgent as unknown as Agent);
      await newComponent.destroy(); // 未初始化就销毁
      
      expect(mockMCPClient.destroy).not.toHaveBeenCalled();
      expect(newComponent.isInitialized()).toBe(false);
    });
  });
  
  describe('错误处理', () => {
    test('应该在未初始化时拒绝调用方法', async () => {
      await expect(mcpComponent.connect())
        .rejects.toThrow('MCPComponent not initialized');
      
      await expect(mcpComponent.disconnect())
        .rejects.toThrow('MCPComponent not initialized');
      
      await expect(mcpComponent.sendRequest({ method: 'test' }))
        .rejects.toThrow('MCPComponent not initialized');
      
      await expect(mcpComponent.sendNotification({ method: 'test' }))
        .rejects.toThrow('MCPComponent not initialized');
      
      expect(() => mcpComponent.isConnected())
        .toThrow('MCPComponent not initialized');
    });
    
    test('应该处理连接错误', async () => {
      await mcpComponent.initialize();
      mockMCPClient.connect.mockRejectedValueOnce(new Error('Connection Error'));
      
      await expect(mcpComponent.connect()).rejects.toThrow('Connection Error');
      const logger = mockAgent.getLogger();
      expect(logger.error).toHaveBeenCalled();
    });
    
    test('应该处理消息发送错误', async () => {
      await mcpComponent.initialize();
      mockMCPClient.sendRequest.mockRejectedValueOnce(new Error('Send Error'));
      mockMCPClient.isConnected.mockReturnValueOnce(true);
      
      await expect(mcpComponent.sendRequest({ method: 'test' }))
        .rejects.toThrow('Send Error');
      const logger = mockAgent.getLogger();
      expect(logger.error).toHaveBeenCalled();
    });
  });
  
  describe('配置管理', () => {
    test('应该能够获取 MCP 配置', async () => {
      await mcpComponent.initialize();
      
      const config = (mcpComponent as any).getMCPConfig();
      
      expect(config).toBeDefined();
      expect(config.enabled).toBe(true);
      expect(config.serverUrl).toBe('ws://localhost:3000');
      expect(config.reconnect).toBe(true);
      expect(config.timeout).toBe(30000);
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
  });
});