/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import { Agent } from '../../agent/Agent.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import type { SteeringEnqueueResult } from '../../agent/runtime/ActiveTurnMailbox.js';
import {
  type ResumedSubagent,
  SessionRuntime,
} from '../../agent/runtime/SessionRuntime.js';
import type { AgentSession } from '../../agent/subagents/AgentSessionStore.js';
import type { UserMessageContent } from '../../agent/types.js';
import { registerCleanup } from '../../services/GracefulShutdown.js';
import {
  type RewindSessionOptions,
  type RewoundSession,
  type SessionRewindCheckpoint,
  SessionService,
} from '../../services/SessionService.js';
import { vanillaStore } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';

export interface AgentOptions {
  sessionId?: string;
  workspaceRoot?: string;
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
  const persistedModelRef = useRef<
    | {
        sessionId: string;
        modelId?: string;
      }
    | undefined
  >(undefined);
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
    persistedModelRef.current = undefined;

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

  const getOrCreateSessionRuntime = useMemoizedFn(
    async (sessionId: string): Promise<SessionRuntime> => {
      const workspaceRoot = options.workspaceRoot ?? getCwd();
      if (
        runtimeRef.current &&
        (runtimeRef.current.sessionId !== sessionId ||
          runtimeRef.current.workspaceRoot !== workspaceRoot)
      ) {
        await cleanupAgent();
      }
      if (!runtimeRef.current) {
        runtimeRef.current = await SessionRuntime.create({
          sessionId,
          workspaceRoot,
          modelId: options.modelId,
        });
        try {
          const metadata = await SessionService.findSessionMetadata(
            sessionId,
            runtimeRef.current.workspaceRoot
          );
          persistedModelRef.current = {
            sessionId,
            modelId: metadata?.selectedModelId,
          };
        } catch (error) {
          const runtime = runtimeRef.current;
          runtimeRef.current = undefined;
          await runtime.dispose().catch(() => undefined);
          throw error;
        }
      }
      return runtimeRef.current;
    }
  );

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
        const runtime = await getOrCreateSessionRuntime(sessionId);
        const requestedModelId = overrides?.modelId ?? options.modelId;
        const previousModelId = runtime.getCurrentModelId();
        await runtime.refresh({
          modelId: requestedModelId,
        });
        if (
          requestedModelId &&
          requestedModelId !== 'inherit' &&
          (persistedModelRef.current?.sessionId !== sessionId ||
            persistedModelRef.current.modelId !== requestedModelId)
        ) {
          try {
            const metadata = await SessionService.updateSessionMetadata(
              sessionId,
              runtime.workspaceRoot,
              { selectedModelId: requestedModelId }
            );
            persistedModelRef.current = {
              sessionId,
              modelId: metadata.selectedModelId,
            };
          } catch (error) {
            if (previousModelId && previousModelId !== requestedModelId) {
              await runtime
                .refresh({ modelId: previousModelId })
                .catch(() => undefined);
            }
            throw error;
          }
        }

        agent = await Agent.createWithRuntime(runtime, {
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

  const listRewindCheckpoints = useMemoizedFn(
    async (): Promise<SessionRewindCheckpoint[]> => {
      if (!options.sessionId) {
        throw new Error('No active session to rewind');
      }
      return (
        await getOrCreateSessionRuntime(options.sessionId)
      ).listRewindCheckpoints();
    }
  );

  const rewindSession = useMemoizedFn(
    async (rewindOptions: RewindSessionOptions): Promise<RewoundSession> => {
      if (!options.sessionId) {
        throw new Error('No active session to rewind');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      const result = await runtime.rewindSession(rewindOptions);
      await cleanupAgent();
      return result;
    }
  );

  const listSubagents = useMemoizedFn(async (): Promise<AgentSession[]> => {
    if (!options.sessionId) {
      throw new Error('No active session for subagent control');
    }
    return (await getOrCreateSessionRuntime(options.sessionId)).listSubagents();
  });

  const resumeSubagent = useMemoizedFn(
    async (agentId: string, prompt: string): Promise<ResumedSubagent> => {
      if (!options.sessionId) {
        throw new Error('No active session for subagent control');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      let announced = false;
      let pendingCompletion: AgentSession | undefined;
      const complete = (session: AgentSession) => {
        vanillaStore
          .getState()
          .app.actions.completeSubagentProgress(session.status === 'completed');
      };
      const result = runtime.resumeSubagent({
        agentId,
        prompt,
        onEvent: (event: LoopEvent) => {
          if (event.kind === 'tool_start' && 'function' in event.toolCall) {
            vanillaStore
              .getState()
              .app.actions.updateSubagentTool(event.toolCall.function.name);
          }
        },
        onCompleted: (session) => {
          if (announced) complete(session);
          else pendingCompletion = session;
        },
      });
      vanillaStore
        .getState()
        .app.actions.startSubagentProgress(
          result.session.id,
          result.session.subagentType,
          `Resumed from ${result.source.id}: ${result.session.description}`
        );
      announced = true;
      if (pendingCompletion) complete(pendingCompletion);
      return result;
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
    listRewindCheckpoints,
    rewindSession,
    listSubagents,
    resumeSubagent,
  };
}
