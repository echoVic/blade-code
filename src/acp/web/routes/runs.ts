/**
 * 运行管理路由（ACP 协议核心端点）
 *
 * POST /runs - 创建运行（支持 sync/stream 模式）
 * GET /runs/:id - 获取运行状态
 * POST /runs/:id - 恢复运行
 * POST /runs/:id/cancel - 取消运行
 * GET /runs/:id/events - SSE 事件流
 */

import { EventEmitter } from 'node:events';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LRUCache } from 'lru-cache';
import { nanoid } from 'nanoid';
import { Agent } from '../../../agent/Agent.js';
import type { ChatContext, LoopOptions } from '../../../agent/types.js';
import { createLogger, LogCategory } from '../../../logging/Logger.js';
import type { ACPMessage, CreateRunRequest, RunInfo } from '../types.js';

const logger = createLogger(LogCategory.SERVICE);

// 运行事件类型
type RunEventType = 'status' | 'output' | 'done';

interface RunEntry {
  info: RunInfo;
  agent?: Agent;
  abortController: AbortController;
  emitter: EventEmitter; // 用于 SSE 事件推送
}

// 存储活跃的运行，使用 LRU Cache 防止内存泄漏
// 最多保留 100 个运行记录，超过 30 分钟自动过期
const activeRuns = new LRUCache<string, RunEntry>({
  max: 100,
  ttl: 30 * 60 * 1000, // 30 分钟
  dispose: (value, key) => {
    // 清理时取消未完成的运行
    if (value.info.status === 'in-progress' || value.info.status === 'created') {
      value.abortController.abort();
      logger.debug(`[runs] Run ${key} disposed due to cache eviction`);
    }
    // 移除所有监听器
    value.emitter.removeAllListeners();
  },
});

export function createRunRoutes(): Hono {
  const app = new Hono();

  // POST /runs - 创建运行
  app.post('/', async (c) => {
    try {
      const body = await c.req.json<CreateRunRequest>();
      const { agent_name, session_id, input, mode } = body;

      // 验证 Agent 名称
      if (agent_name !== 'blade-code') {
        return c.json(
          {
            code: 'not_found',
            message: `Agent not found: ${agent_name}`,
          },
          404
        );
      }

      // 验证输入
      if (!input || input.length === 0) {
        return c.json(
          {
            code: 'invalid_input',
            message: 'Input messages are required',
          },
          400
        );
      }

      const runId = nanoid();
      const cwd = c.get('cwd');
      const now = new Date().toISOString();

      // 创建运行信息
      const runInfo: RunInfo = {
        id: runId,
        agent_name,
        session_id,
        status: 'created',
        created_at: now,
        updated_at: now,
      };

      // 创建时就初始化 AbortController 和 EventEmitter
      const abortController = new AbortController();
      const emitter = new EventEmitter();
      activeRuns.set(runId, { info: runInfo, abortController, emitter });

      // 根据模式处理
      if (mode === 'sync') {
        // 同步模式：等待完成后返回
        return await handleSyncRun(c, runId, input, cwd);
      } else if (mode === 'stream') {
        // 流式模式：返回 202，客户端通过 SSE 获取事件
        runInfo.status = 'in-progress';
        runInfo.updated_at = new Date().toISOString();

        // 异步执行
        executeRunAsync(runId, input, cwd).catch((error) => {
          logger.error(`[runs] Run ${runId} failed:`, error);
        });

        return c.json(runInfo, 202);
      } else if (mode === 'async') {
        // 异步模式：立即返回，稍后查询
        runInfo.status = 'in-progress';
        runInfo.updated_at = new Date().toISOString();

        // 异步执行
        executeRunAsync(runId, input, cwd).catch((error) => {
          logger.error(`[runs] Run ${runId} failed:`, error);
        });

        return c.json(runInfo, 202);
      } else {
        return c.json(
          {
            code: 'invalid_input',
            message: `Invalid mode: ${mode}. Must be 'sync', 'async', or 'stream'`,
          },
          400
        );
      }
    } catch (error) {
      logger.error('[runs] Failed to create run:', error);
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to create run',
        },
        500
      );
    }
  });

  // GET /runs/:id - 获取运行状态
  app.get('/:id', (c) => {
    const runId = c.req.param('id');
    const run = activeRuns.get(runId);

    if (!run) {
      return c.json(
        {
          code: 'not_found',
          message: `Run not found: ${runId}`,
        },
        404
      );
    }

    return c.json(run.info);
  });

  // POST /runs/:id/cancel - 取消运行
  app.post('/:id/cancel', (c) => {
    const runId = c.req.param('id');
    const run = activeRuns.get(runId);

    if (!run) {
      return c.json(
        {
          code: 'not_found',
          message: `Run not found: ${runId}`,
        },
        404
      );
    }

    // 触发 abort 信号
    run.abortController.abort();

    // 只有在运行中才更新状态为 cancelled
    if (run.info.status === 'created' || run.info.status === 'in-progress') {
      run.info.status = 'cancelled';
      run.info.updated_at = new Date().toISOString();
      // 通知 SSE 监听器
      run.emitter.emit('status', run.info);
      run.emitter.emit('done');
    }

    return c.json(run.info);
  });

  // GET /runs/:id/events - SSE 事件流
  app.get('/:id/events', async (c) => {
    const runId = c.req.param('id');
    const run = activeRuns.get(runId);

    if (!run) {
      return c.json(
        {
          code: 'not_found',
          message: `Run not found: ${runId}`,
        },
        404
      );
    }

    return streamSSE(c, async (stream) => {
      // 发送当前状态
      await stream.writeSSE({
        event: `run.${run.info.status}`,
        data: JSON.stringify(run.info),
      });

      // 如果已经完成，直接返回
      if (
        run.info.status === 'completed' ||
        run.info.status === 'failed' ||
        run.info.status === 'cancelled'
      ) {
        return;
      }

      // 使用 EventEmitter 监听事件，避免轮询
      const statusHandler = async (info: RunInfo) => {
        try {
          await stream.writeSSE({
            event: `run.${info.status}`,
            data: JSON.stringify(info),
          });
        } catch {
          // 连接可能已关闭
        }
      };

      const outputHandler = async (output: RunInfo['output']) => {
        try {
          await stream.writeSSE({
            event: 'message.part',
            data: JSON.stringify({
              run_id: runId,
              output,
            }),
          });
        } catch {
          // 连接可能已关闭
        }
      };

      // 注册监听器
      run.emitter.on('status', statusHandler);
      run.emitter.on('output', outputHandler);

      // 等待完成信号
      await new Promise<void>((resolve) => {
        const doneHandler = () => {
          resolve();
        };
        run.emitter.once('done', doneHandler);

        // 如果连接关闭，也要清理
        stream.onAbort(() => {
          run.emitter.off('done', doneHandler);
          resolve();
        });
      });

      // 清理监听器
      run.emitter.off('status', statusHandler);
      run.emitter.off('output', outputHandler);

      // 发送最终状态
      const finalRun = activeRuns.get(runId);
      if (finalRun && finalRun.info.status !== run.info.status) {
        await stream.writeSSE({
          event: `run.${finalRun.info.status}`,
          data: JSON.stringify(finalRun.info),
        });
      }
    });
  });

  return app;
}

/**
 * 同步执行运行
 */
async function handleSyncRun(
  c: Context,
  runId: string,
  input: ACPMessage[],
  cwd: string
): Promise<Response> {
  const run = activeRuns.get(runId);
  if (!run) {
    return c.json({ code: 'not_found', message: 'Run not found' }, 404);
  }

  // 检查是否在开始前就已被取消
  if (run.abortController.signal.aborted) {
    run.info.status = 'cancelled';
    run.info.updated_at = new Date().toISOString();
    return c.json(run.info);
  }

  try {
    run.info.status = 'in-progress';
    run.info.updated_at = new Date().toISOString();

    // 创建 Agent
    const agent = await Agent.create({});
    run.agent = agent;

    // 转换输入消息
    const userMessage = extractUserMessage(input);

    // 准备上下文
    const context: ChatContext = {
      messages: [],
      userId: 'web-user',
      sessionId: run.info.session_id || runId,
      workspaceRoot: cwd,
    };

    // 执行 Agent
    let fullResponse = '';
    const loopOptions: LoopOptions = {
      signal: run.abortController.signal,
      onContentDelta: (delta: string) => {
        fullResponse += delta;
      },
    };

    await agent.runAgenticLoop(userMessage, context, loopOptions);

    // 检查是否被取消（不要覆盖 cancelled 状态）
    if (run.info.status === 'cancelled' || run.abortController.signal.aborted) {
      if (run.info.status !== 'cancelled') {
        run.info.status = 'cancelled';
        run.info.updated_at = new Date().toISOString();
      }
      return c.json(run.info);
    }

    // 更新运行状态
    run.info.status = 'completed';
    run.info.updated_at = new Date().toISOString();
    run.info.output = [
      {
        role: 'agent',
        parts: [
          {
            content_type: 'text/plain',
            content: fullResponse,
          },
        ],
      },
    ];

    return c.json(run.info);
  } catch (error) {
    // 如果是因为取消导致的错误，设置为 cancelled
    if (run.abortController.signal.aborted || run.info.status === 'cancelled') {
      if (run.info.status !== 'cancelled') {
        run.info.status = 'cancelled';
        run.info.updated_at = new Date().toISOString();
      }
      return c.json(run.info);
    }

    run.info.status = 'failed';
    run.info.updated_at = new Date().toISOString();
    run.info.error = {
      code: 'server_error',
      message: error instanceof Error ? error.message : 'Run failed',
    };

    return c.json(run.info, 500);
  }
}

/**
 * 异步执行运行
 */
async function executeRunAsync(
  runId: string,
  input: ACPMessage[],
  cwd: string
): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run) return;

  // 检查是否在开始前就已被取消
  if (run.abortController.signal.aborted) {
    if (run.info.status !== 'cancelled') {
      run.info.status = 'cancelled';
      run.info.updated_at = new Date().toISOString();
      run.emitter.emit('status', run.info);
      run.emitter.emit('done');
    }
    return;
  }

  try {
    // 创建 Agent
    const agent = await Agent.create({});
    run.agent = agent;

    // 再次检查取消状态（Agent 创建可能需要时间）
    if (run.abortController.signal.aborted || run.info.status === 'cancelled') {
      if (run.info.status !== 'cancelled') {
        run.info.status = 'cancelled';
        run.info.updated_at = new Date().toISOString();
        run.emitter.emit('status', run.info);
        run.emitter.emit('done');
      }
      return;
    }

    // 转换输入消息
    const userMessage = extractUserMessage(input);

    // 准备上下文
    const context: ChatContext = {
      messages: [],
      userId: 'web-user',
      sessionId: run.info.session_id || runId,
      workspaceRoot: cwd,
    };

    // 执行 Agent
    let fullResponse = '';
    const loopOptions: LoopOptions = {
      signal: run.abortController.signal,
      onContentDelta: (delta: string) => {
        // 如果已取消，不再更新输出
        if (run.info.status === 'cancelled' || run.abortController.signal.aborted) {
          return;
        }
        fullResponse += delta;
        // 更新输出（用于流式）
        run.info.output = [
          {
            role: 'agent',
            parts: [
              {
                content_type: 'text/plain',
                content: fullResponse,
              },
            ],
          },
        ];
        // 通知 SSE 监听器
        run.emitter.emit('output', run.info.output);
      },
    };

    await agent.runAgenticLoop(userMessage, context, loopOptions);

    // 检查是否被取消（不要覆盖 cancelled 状态）
    if (run.info.status === 'cancelled' || run.abortController.signal.aborted) {
      if (run.info.status !== 'cancelled') {
        run.info.status = 'cancelled';
        run.info.updated_at = new Date().toISOString();
        run.emitter.emit('status', run.info);
      }
      run.emitter.emit('done');
      return;
    }

    // 更新运行状态
    run.info.status = 'completed';
    run.info.updated_at = new Date().toISOString();
    run.info.output = [
      {
        role: 'agent',
        parts: [
          {
            content_type: 'text/plain',
            content: fullResponse,
          },
        ],
      },
    ];
    // 通知 SSE 监听器
    run.emitter.emit('status', run.info);
    run.emitter.emit('done');
  } catch (error) {
    // 如果是因为取消导致的错误，设置为 cancelled
    if (run.abortController.signal.aborted || run.info.status === 'cancelled') {
      if (run.info.status !== 'cancelled') {
        run.info.status = 'cancelled';
        run.info.updated_at = new Date().toISOString();
        run.emitter.emit('status', run.info);
      }
      run.emitter.emit('done');
      return;
    }

    run.info.status = 'failed';
    run.info.updated_at = new Date().toISOString();
    run.info.error = {
      code: 'server_error',
      message: error instanceof Error ? error.message : 'Run failed',
    };
    // 通知 SSE 监听器
    run.emitter.emit('status', run.info);
    run.emitter.emit('done');
    logger.error(`[runs] Run ${runId} failed:`, error);
  }
}

/**
 * 从 ACP 消息中提取用户消息文本
 */
function extractUserMessage(messages: ACPMessage[]): string {
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) return '';

  const lastMessage = userMessages[userMessages.length - 1];
  const textParts = lastMessage.parts.filter(
    (p) => p.content_type === 'text/plain' || p.content_type.startsWith('text/')
  );

  return textParts.map((p) => p.content || '').join('\n');
}
