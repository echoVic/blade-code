/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useRef } from 'react';
import { Agent } from '../../agent/Agent.js';

export interface AgentOptions {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
}

/**
 * Agent 管理 Hook
 * 提供创建和清理 Agent 的方法
 *
 * 注意：Agent 现在直接通过 vanilla store 更新 todos，
 * 不再需要 onTodoUpdate 回调
 *
 * @param options - Agent 配置选项
 * @returns Agent ref 和创建/清理方法
 */
export function useAgent(options: AgentOptions) {
  const agentRef = useRef<Agent | undefined>(undefined);

  /**
   * 创建并设置 Agent 实例
   */
  const createAgent = useMemoizedFn(async (): Promise<Agent> => {
    // 创建新 Agent
    const agent = await Agent.create({
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: options.maxTurns,
    });
    agentRef.current = agent;

    // Agent 现在直接通过 vanilla store 更新 UI 状态
    // 不再需要设置事件监听器

    return agent;
  });

  /**
   * 清理 Agent 实例
   */
  const cleanupAgent = useMemoizedFn(() => {
    if (agentRef.current) {
      agentRef.current = undefined;
    }
  });

  return {
    agentRef,
    createAgent,
    cleanupAgent,
  };
}
