/**
 * Mock Agent
 *
 * 用于测试 BladeAgent 和 Session，模拟 Agent 类
 */

import type { Agent } from '../../src/agent/Agent.js';
import type { ChatContext, LoopOptions, LoopResult } from '../../src/agent/types.js';
import { vi } from 'vitest';

export interface MockAgentCall {
  message: string;
  context: ChatContext;
  options?: LoopOptions;
}

export class MockAgent implements Partial<Agent> {
  public calls: MockAgentCall[] = [];
  public chatResponses: Map<string, string> = new Map();
  public chatResult: LoopResult | null = null;
  public shouldThrow: Error | null = null;

  // 模拟 destroy 方法
  async destroy(): Promise<void> {
    return Promise.resolve();
  }

  // 模拟 chat 方法
  async chat(message: string, context: ChatContext, options?: LoopOptions): Promise<string> {
    // 记录调用
    this.calls.push({ message, context, options });

    // 检查是否应该抛出错误
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }

    // 检查是否有预设响应
    const key = `${message}-${context.sessionId}`;
    if (this.chatResponses.has(key)) {
      return this.chatResponses.get(key)!;
    }

    // 检查是否有默认响应
    if (this.chatResponses.has('*')) {
      return this.chatResponses.get('*')!;
    }

    // 检查是否有预设结果
    if (this.chatResult) {
      // 模拟返回结果
      return this.chatResult.response || 'Mock response';
    }

    // 默认返回空字符串
    return '';
  }

  // 设置 chat 响应
  setChatResponse(message: string, sessionId: string, response: string): void {
    this.chatResponses.set(`${message}-${sessionId}`, response);
  }

  // 设置默认响应
  setDefaultResponse(response: string): void {
    this.chatResponses.set('*', response);
  }

  // 设置 chat 结果
  setChatResult(result: LoopResult): void {
    this.chatResult = result;
  }

  // 设置应该抛出的错误
  setThrow(error: Error): void {
    this.shouldThrow = error;
  }

  // 清除所有记录
  clear(): void {
    this.calls = [];
    this.chatResponses.clear();
    this.chatResult = null;
    this.shouldThrow = null;
  }

  // 获取调用次数
  getCallCount(): number {
    return this.calls.length;
  }

  // 获取最后一次调用
  getLastCall(): MockAgentCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  // 获取指定会话的所有调用
  getCallsForSession(sessionId: string): MockAgentCall[] {
    return this.calls.filter((call) => call.context.sessionId === sessionId);
  }
}

export function createMockAgent(): MockAgent {
  return new MockAgent();
}
