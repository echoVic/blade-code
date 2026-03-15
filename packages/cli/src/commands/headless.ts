import { Agent } from '../agent/Agent.js';
import type { ChatContext, LoopOptions } from '../agent/types.js';
import { PermissionMode } from '../config/index.js';
import type { GlobalOptions } from '../cli/types.js';

interface HeadlessOptions extends GlobalOptions {
  /** 从默认命令解析出的初始消息 */
  initialMessage?: string;
}

function getToolName(toolCall: unknown): string | undefined {
  const anyCall = toolCall as any;
  if (anyCall?.function && typeof anyCall.function.name === 'string') {
    return anyCall.function.name as string;
  }
  if (typeof anyCall?.name === 'string') {
    return anyCall.name as string;
  }
  return undefined;
}

/**
 * 在默认命令中启用 headless 模式时调用
 * - 不使用 Ink/React 渲染
 * - 所有对话、工具调用和代码修改建议通过 console.log 输出
 * - 自动确认所有工具调用（包括写操作）
 */
export async function runHeadlessChat(options: HeadlessOptions): Promise<void> {
  const {
    initialMessage,
    outputFormat = 'text',
    includePartialMessages,
    inputFormat = 'text',
    maxTurns,
    systemPrompt,
    appendSystemPrompt,
    mcpConfig,
    strictMcpConfig,
    permissionMode,
    yolo,
    sessionId,
    provider,
    model,
    apiKey,
    baseUrl,
  } = options;

  // 1. 解析输入：优先使用 initialMessage，其次从 stdin 读取
  let input = initialMessage ?? '';

  if (!input || input.trim() === '') {
    if (!process.stdin.isTTY && inputFormat === 'text') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      input = Buffer.concat(chunks).toString('utf-8').trim();
    }

    if (!input) {
      input = 'Hello';
    }
  }

  // 2. 计算权限模式：headless 下默认使用 YOLO，确保无需人工确认
  let effectivePermissionMode: PermissionMode;
  if (permissionMode === 'autoEdit') {
    effectivePermissionMode = PermissionMode.AUTO_EDIT;
  } else if (permissionMode === 'plan') {
    effectivePermissionMode = PermissionMode.PLAN;
  } else if (permissionMode === 'yolo' || yolo) {
    effectivePermissionMode = PermissionMode.YOLO;
  } else {
    // 在 headless 模式下，DEFAULT 也提升为 YOLO，避免交互确认
    effectivePermissionMode = PermissionMode.YOLO;
  }

  try {
    // 3. 创建 Agent - 使用运行时选项覆盖配置
    const agent = await Agent.create({
      systemPrompt,
      appendSystemPrompt,
      maxTurns,
      permissionMode: effectivePermissionMode,
      mcpConfig,
      strictMcpConfig,
      provider,
      model,
      apiKey,
      baseUrl,
    });

    const chatContext: ChatContext = {
      messages: [],
      userId: 'cli-headless',
      sessionId:
        sessionId ||
        `headless-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      workspaceRoot: process.cwd(),
      permissionMode: effectivePermissionMode,
    };

    const useStreaming = outputFormat === 'stream-json' || !!includePartialMessages;

    // 4. 事件回调：统一输出为结构化 JSON，便于脚本消费
    const loopOptions: LoopOptions = {
      maxTurns,
      stream: useStreaming,

      onTurnStart: ({ turn, maxTurns: configuredMaxTurns }) => {
        console.log(
          JSON.stringify(
            {
              type: 'turn_start',
              turn,
              maxTurns: configuredMaxTurns,
            },
            null,
            2
          )
        );
      },

      onContentDelta: (delta) => {
        if (outputFormat === 'stream-json') {
          console.log(JSON.stringify({ type: 'content_delta', delta }));
        } else if (includePartialMessages) {
          process.stdout.write(delta);
        }
      },

      onStreamEnd: () => {
        if (outputFormat === 'stream-json') {
          console.log(JSON.stringify({ type: 'stream_end' }));
        }
      },

      onContent: (content) => {
        if (outputFormat === 'json') {
          console.log(
            JSON.stringify(
              {
                type: 'final',
                message: content,
              },
              null,
              2
            )
          );
        } else if (outputFormat === 'stream-json') {
          console.log(JSON.stringify({ type: 'final', message: content }));
        } else {
          console.log(content);
        }
      },

      onToolStart: (toolCall, toolKind) => {
        console.log(
          JSON.stringify(
            {
              type: 'tool_start',
              toolName: getToolName(toolCall),
              toolKind,
              toolCallId: toolCall.id,
            },
            null,
            2
          )
        );
      },

      // 自动批准所有工具调用（包括写入、执行类），避免交互
      onToolApprove: async (toolCall) => {
        console.log(
          JSON.stringify(
            {
              type: 'tool_approve',
              toolName: getToolName(toolCall),
              toolCallId: toolCall.id,
              reason: 'auto-approved in headless mode',
            },
            null,
            2
          )
        );
        return true;
      },

      onToolResult: async (toolCall, result) => {
        console.log(
          JSON.stringify(
            {
              type: 'tool_result',
              toolName: getToolName(toolCall),
              toolCallId: toolCall.id,
              result,
            },
            null,
            2
          )
        );
        return result;
      },

      onTokenUsage: (usage) => {
        console.log(JSON.stringify({ type: 'token_usage', ...usage }));
      },

      onTurnLimitReached: async ({ turnsCount }) => {
        console.log(
          JSON.stringify(
            {
              type: 'turn_limit_reached',
              turnsCount,
              action: 'auto-continue',
            },
            null,
            2
          )
        );
        return { continue: true, reason: 'auto-continue in headless mode' };
      },
    };

    await agent.chat(input, chatContext, loopOptions);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify(
        {
          type: 'error',
          message,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}
