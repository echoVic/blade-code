/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import { Agent } from '../../agent/Agent.js';
import type { SteeringEnqueueResult } from '../../agent/runtime/ActiveTurnMailbox.js';
import { SessionRuntime } from '../../agent/runtime/SessionRuntime.js';
import type { UserMessageContent } from '../../agent/types.js';
import { registerCleanup } from '../../services/GracefulShutdown.js';
import { getCwd } from '../../utils/cwd.js';

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
  const cleanupPromiseRef = useRef<Promise<void> | undefined>(undefined);

  /**
   * Release the complete runtime ownership boundary. Clearing refs first makes
   * concurrent shutdown/unmount cleanup idempotent while disposal is in flight.
   */
  const cleanupAgent = useMemoizedFn(async (): Promise<void> => {
    if (cleanupPromiseRef.current) {
      return cleanupPromiseRef.current;
    }

    const agent = agentRef.current;
    const runtime = runtimeRef.current;
    if (!agent && !runtime) return;

    agentRef.current = undefined;
    runtimeRef.current = undefined;

    const cleanupPromise = (async () => {
      try {
        await agent?.destroy();
      } finally {
        await runtime?.dispose();
      }
    })();
    cleanupPromiseRef.current = cleanupPromise;

    try {
      await cleanupPromise;
    } finally {
      if (cleanupPromiseRef.current === cleanupPromise) {
        cleanupPromiseRef.current = undefined;
      }
    }
  });

  /**
   * 创建并设置 Agent 实例
   */
  const createAgent = useMemoizedFn(
    async (overrides?: Partial<AgentOptions>): Promise<Agent> => {
      const sessionId = overrides?.sessionId ?? options.sessionId;
      const shouldUseEphemeralRuntime =
        !!overrides?.modelId && overrides.modelId !== options.modelId;

      let agent: Agent;
      if (!shouldUseEphemeralRuntime && sessionId) {
        if (runtimeRef.current && runtimeRef.current.sessionId !== sessionId) {
          await cleanupAgent();
        }

        if (!runtimeRef.current) {
          runtimeRef.current = await SessionRuntime.create({
            sessionId,
            workspaceRoot: getCwd(),
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
          appendSystemPrompt:
            overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
          maxTurns: overrides?.maxTurns ?? options.maxTurns,
          modelId: overrides?.modelId ?? options.modelId,
        });
      } else {
        agent = await Agent.create({
          systemPrompt: overrides?.systemPrompt ?? options.systemPrompt,
          appendSystemPrompt:
            overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
          maxTurns: overrides?.maxTurns ?? options.maxTurns,
          modelId: overrides?.modelId ?? options.modelId,
        });
      }
      agentRef.current = agent;

      // Agent 现在直接通过 vanilla store 更新 UI 状态
      // 不再需要设置事件监听器

      return agent;
    }
  );

  const steerActiveTurn = useMemoizedFn(
    async (content: UserMessageContent): Promise<SteeringEnqueueResult> => {
      if (!runtimeRef.current) {
        return { accepted: false, queued: 0, reason: 'no_active_turn' };
      }
      return runtimeRef.current.enqueueSteering(content, {
        allowBeforeTurn: true,
      });
    }
  );

  useEffect(() => {
    const unregisterCleanup = registerCleanup(cleanupAgent);
    return () => {
      unregisterCleanup();
      void cleanupAgent().catch(() => undefined);
    };
  }, [cleanupAgent]);

  return {
    agentRef,
    createAgent,
    cleanupAgent,
    steerActiveTurn,
  };
}
