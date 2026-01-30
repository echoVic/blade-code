/**
 * Mock ACP Client
 *
 * 用于测试 BladeAgent 和 Session，模拟 ACP 协议的 AgentSideConnection
 */

import type {
  AgentSideConnection,
  SessionNotification,
  RequestPermissionRequest,
  PermissionRequestResponse,
} from '@agentclientprotocol/sdk';
import { vi } from 'vitest';

export class MockACPClient implements AgentSideConnection {
  public sessionUpdates: SessionNotification[] = [];
  public permissionRequests: RequestPermissionRequest[] = [];
  public permissionResponses: Map<string, PermissionRequestResponse> = new Map();

  // 模拟 sessionUpdate 方法
  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
    return Promise.resolve();
  }

  // 模拟 requestPermission 方法
  async requestPermission(params: RequestPermissionRequest): Promise<PermissionRequestResponse> {
    this.permissionRequests.push(params);

    // 默认允许（可以在测试中覆盖）
    const toolCallId = params.toolCall.toolCallId;
    const response = this.permissionResponses.get(toolCallId) || {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };

    return Promise.resolve(response);
  }

  // 设置权限响应
  setPermissionResponse(toolCallId: string, response: PermissionRequestResponse): void {
    this.permissionResponses.set(toolCallId, response);
  }

  // 清除所有记录
  clear(): void {
    this.sessionUpdates = [];
    this.permissionRequests = [];
    this.permissionResponses.clear();
  }

  // 获取最后一条会话更新
  getLastSessionUpdate(): SessionNotification | undefined {
    return this.sessionUpdates[this.sessionUpdates.length - 1];
  }

  // 获取最后一条权限请求
  getLastPermissionRequest(): RequestPermissionRequest | undefined {
    return this.permissionRequests[this.permissionRequests.length - 1];
  }
}

export function createMockACPClient(): MockACPClient {
  return new MockACPClient();
}
