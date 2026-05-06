/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useRef } from 'react';
import { Agent } from '../../agent/Agent.js';
import { SessionRuntime } from '../../agent/runtime/SessionRuntime.js';

export interface AgentOptions {
  sessionId?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  modelId?: string;
}

/**
 * Agent 管理 Hook
 * 提供创建和清理 Agent 的方法
 *
 * 注意：Agent 现在直接通过 vanilla store 更新 tasks，
 * 不再需要 onTaskUpdate 回调
 *
 * @param options - Agent 配置选项
 * @returns Agent ref 和创建/清理方法
 */
export function useAgent(options: AgentOptions) {
  const agentRef = useRef<Agent | undefined>(undefined);
  const runtimeRef = useRef<SessionRuntime | undefined>(undefined);

  /**
   * 创建并设置 Agent 实例
   */
  const createAgent = useMemoizedFn(async (overrides?: Partial<AgentOptions>): Promise<Agent> => {
    const sessionId = overrides?.sessionId ?? options.sessionId;
    const shouldUseEphemeralRuntime =
      !!overrides?.modelId && overrides.modelId !== options.modelId;

    let agent: Agent;
    if (!shouldUseEphemeralRuntime && sessionId) {
      if (runtimeRef.current && runtimeRef.current.sessionId !== sessionId) {
        await runtimeRef.current.dispose();
        runtimeRef.current = undefined;
      }

      if (!runtimeRef.current) {
        runtimeRef.current = await SessionRuntime.create({
          sessionId,
          modelId: overrides?.modelId ?? options.modelId,
        });
      } else {
        await runtimeRef.current.refresh({
          modelId: overrides?.modelId ?? options.modelId,
        });
      }

      agent = await Agent.createWithRuntime(runtimeRef.current, {
        sessionId,
        systemPrompt: overrides?.systemPrompt ?? options.systemPrompt,
        appendSystemPrompt: overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
        maxTurns: overrides?.maxTurns ?? options.maxTurns,
        modelId: overrides?.modelId ?? options.modelId,
      });
    } else {
      agent = await Agent.create({
        systemPrompt: overrides?.systemPrompt ?? options.systemPrompt,
        appendSystemPrompt: overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
        maxTurns: overrides?.maxTurns ?? options.maxTurns,
        modelId: overrides?.modelId ?? options.modelId,
      });
    }
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
