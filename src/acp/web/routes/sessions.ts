/**
 * 会话管理路由（普通 HTTP API）
 *
 * GET /api/sessions - 列出所有会话
 * POST /api/sessions - 创建新会话
 * GET /api/sessions/:id - 获取会话详情
 * DELETE /api/sessions/:id - 删除会话
 * GET /api/sessions/:id/messages - 获取消息历史
 */

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { readFile } from 'node:fs/promises';
import type { BladeJSONLEntry } from '../../../context/types.js';
import { SessionService } from '../../../services/SessionService.js';
import type { ACPMessage, CreateSessionResponse, SessionInfo } from '../types.js';

export function createSessionRoutes(): Hono {
  const app = new Hono();

  // GET /api/sessions - 列出所有会话
  app.get('/', async (c) => {
    try {
      const sessions = await SessionService.listSessions();

      const sessionInfos: SessionInfo[] = sessions.map((s) => ({
        id: s.sessionId,
        project_path: s.projectPath,
        git_branch: s.gitBranch,
        message_count: s.messageCount,
        first_message_time: s.firstMessageTime,
        last_message_time: s.lastMessageTime,
        has_errors: s.hasErrors,
        // TODO: 从第一条用户消息提取标题
        title: undefined,
      }));

      return c.json({ sessions: sessionInfos });
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to list sessions',
        },
        500
      );
    }
  });

  // POST /api/sessions - 创建新会话
  app.post('/', async (c) => {
    try {
      // 生成新的会话 ID
      const sessionId = nanoid();

      // 返回会话 ID（实际的会话创建在第一次 POST /runs 时发生）
      const response: CreateSessionResponse = {
        session_id: sessionId,
      };

      return c.json(response, 201);
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to create session',
        },
        500
      );
    }
  });

  // GET /api/sessions/:id - 获取会话详情
  app.get('/:id', async (c) => {
    const sessionId = c.req.param('id');

    try {
      const sessions = await SessionService.listSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);

      if (!session) {
        return c.json(
          {
            code: 'not_found',
            message: `Session not found: ${sessionId}`,
          },
          404
        );
      }

      return c.json({
        id: session.sessionId,
        project_path: session.projectPath,
        git_branch: session.gitBranch,
        message_count: session.messageCount,
        first_message_time: session.firstMessageTime,
        last_message_time: session.lastMessageTime,
        has_errors: session.hasErrors,
      });
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to get session',
        },
        500
      );
    }
  });

  // GET /api/sessions/:id/messages - 获取消息历史
  app.get('/:id/messages', async (c) => {
    const sessionId = c.req.param('id');

    try {
      const sessions = await SessionService.listSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);

      if (!session) {
        return c.json(
          {
            code: 'not_found',
            message: `Session not found: ${sessionId}`,
          },
          404
        );
      }

      // 读取 JSONL 文件
      const content = await readFile(session.filePath, 'utf-8');
      const lines = content.trim().split('\n');
      const messages: ACPMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as BladeJSONLEntry;
          // BladeJSONLEntry 的 type 是 'user', 'assistant', 'tool_use' 等
          if (entry.type === 'user' || entry.type === 'assistant') {
            messages.push(convertEntryToACPMessage(entry));
          }
        } catch {
          // 跳过解析错误的行
        }
      }

      return c.json({ messages });
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to get messages',
        },
        500
      );
    }
  });

  // DELETE /api/sessions/:id - 删除会话
  app.delete('/:id', async (c) => {
    const sessionId = c.req.param('id');

    try {
      const sessions = await SessionService.listSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);

      if (!session) {
        return c.json(
          {
            code: 'not_found',
            message: `Session not found: ${sessionId}`,
          },
          404
        );
      }

      // 删除 JSONL 文件
      const { unlink } = await import('node:fs/promises');
      await unlink(session.filePath);

      return c.json({ success: true });
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to delete session',
        },
        500
      );
    }
  });

  return app;
}

/**
 * 将 BladeJSONLEntry 转换为 ACP Message 格式
 */
function convertEntryToACPMessage(entry: BladeJSONLEntry): ACPMessage {
  const content =
    typeof entry.message.content === 'string'
      ? entry.message.content
      : JSON.stringify(entry.message.content);

  return {
    role: entry.type === 'user' ? 'user' : 'agent',
    parts: [
      {
        content_type: 'text/plain',
        content,
      },
    ],
    created_at: entry.timestamp,
  };
}
