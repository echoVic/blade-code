/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useRef } from 'react';
import { Agent } from '../../agent/Agent.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';

export interface AgentOptions {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
}

export interface AgentSetupCallbacks {
  onTodoUpdate: (todos: TodoItem[]) => void;
}

/**
 * Agent 管理 Hook
 * 提供创建和清理 Agent 的方法
 * @param options - Agent 配置选项
 * @param callbacks - Agent 事件回调
 * @returns Agent ref 和创建/清理方法
 */
export function useAgent(options: AgentOptions, callbacks: AgentSetupCallbacks) {
  const agentRef = useRef<Agent | undefined>(undefined);

  /**
   * 创建并设置 Agent 实例
   */
  const createAgent = useMemoizedFn(async (): Promise<Agent> => {
    // 清理旧的 Agent 事件监听器
    if (agentRef.current) {
      agentRef.current.removeAllListeners();
    }

    // 创建新 Agent
    const agent = await Agent.create({
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: options.maxTurns,
    });
    agentRef.current = agent;

    // 设置事件监听器
    agent.on('todoUpdate', ({ todos }: { todos: TodoItem[] }) => {
      callbacks.onTodoUpdate(todos);
    });

    return agent;
  });

  /**
   * 清理 Agent 实例
   */
  const cleanupAgent = useMemoizedFn(() => {
    if (agentRef.current) {
      agentRef.current.removeAllListeners();
      agentRef.current = undefined;
    }
  });

  return {
    agentRef,
    createAgent,
    cleanupAgent,
  };
}
