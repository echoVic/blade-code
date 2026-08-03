import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../../../../src/services/SessionService.js';

const readdirMock = vi.fn();
const readFileMock = vi.fn();
const rmMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args: any[]) => readdirMock(...args),
  readFile: (...args: any[]) => readFileMock(...args),
  rm: (...args: any[]) => rmMock(...args),
}));

vi.mock('../../../../src/context/storage/pathUtils.js', () => ({
  getBladeStorageRoot: () => '/blade-root',
  unescapeProjectPath: (escaped: string) => `/projects/${escaped}`,
  getSessionFilePath: (projectPath: string, sessionId: string) =>
    `${projectPath}/sessions/${sessionId}.jsonl`,
  getSessionInboxFilePath: (projectPath: string, sessionId: string) =>
    `${projectPath}/${sessionId}.inbox.json`,
}));

beforeEach(() => {
  readdirMock.mockReset();
  readFileMock.mockReset();
  rmMock.mockReset();
});

const makeDirent = (name: string, isDir: boolean) => ({
  name,
  isDirectory: () => isDir,
});

describe('SessionService with mocked filesystem', () => {
  it('listSessions 应处理多个项目目录并提取元数据', async () => {
    readdirMock.mockImplementation(async (dir: string, options?: any) => {
      if (dir === '/blade-root/projects' && options?.withFileTypes) {
        return [makeDirent('encodedA', true)];
      }
      if (dir === '/blade-root/projects/encodedA') {
        return ['session-a.jsonl', 'session-b.jsonl'];
      }
      return [];
    });

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('session-a.jsonl')) {
        return [
          JSON.stringify({
            id: 'e1',
            sessionId: 'session-a',
            type: 'session_created',
            timestamp: '2024-01-01T00:00:00Z',
            cwd: '/projects/encodedA',
            gitBranch: 'main',
            version: '0.0.0',
            data: {
              sessionId: 'session-a',
              rootId: 'session-a',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              status: 'running',
            },
          }),
          JSON.stringify({
            id: 'e2',
            sessionId: 'session-a',
            type: 'message_created',
            timestamp: '2024-01-01T00:01:00Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              messageId: 'm1',
              role: 'user',
              createdAt: '2024-01-01T00:01:00Z',
            },
          }),
          JSON.stringify({
            id: 'e3',
            sessionId: 'session-a',
            type: 'message_created',
            timestamp: '2024-01-01T00:01:30Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              messageId: 'm2',
              role: 'assistant',
              createdAt: '2024-01-01T00:01:30Z',
            },
          }),
        ].join('\n');
      }
      if (filePath.endsWith('session-b.jsonl')) {
        return [
          JSON.stringify({
            id: 'e4',
            sessionId: 'session-b',
            type: 'session_created',
            timestamp: '2024-02-01T00:00:00Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              sessionId: 'session-b',
              rootId: 'session-b',
              createdAt: '2024-02-01T00:00:00Z',
              updatedAt: '2024-02-01T00:00:00Z',
              status: 'running',
            },
          }),
          JSON.stringify({
            id: 'e5',
            sessionId: 'session-b',
            type: 'message_created',
            timestamp: '2024-02-01T00:01:00Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              messageId: 'm3',
              role: 'assistant',
              createdAt: '2024-02-01T00:01:00Z',
            },
          }),
          JSON.stringify({
            id: 'e6',
            sessionId: 'session-b',
            type: 'message_created',
            timestamp: '2024-02-01T00:01:30Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              messageId: 'm4',
              role: 'assistant',
              createdAt: '2024-02-01T00:01:30Z',
            },
          }),
          JSON.stringify({
            id: 'e7',
            sessionId: 'session-b',
            type: 'part_created',
            timestamp: '2024-02-01T00:01:40Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              partId: 'p1',
              messageId: 'm4',
              partType: 'tool_result',
              payload: { toolCallId: 'call-9', error: 'boom' },
              createdAt: '2024-02-01T00:01:40Z',
            },
          }),
        ].join('\n');
      }
      throw new Error(`unexpected file ${filePath}`);
    });

    const sessions = await SessionService.listSessions();

    expect(sessions.map((s) => s.sessionId)).toEqual(['session-b', 'session-a']);
    expect(sessions[0]).toMatchObject({
      projectPath: '/projects/encodedA',
      hasErrors: true,
      messageCount: 2,
    });
    expect(sessions[1]).toMatchObject({
      gitBranch: 'main',
      hasErrors: false,
      messageCount: 2,
    });
  });

  it('loadSession 应转换 JSONL 为消息列表', async () => {
    readdirMock.mockResolvedValue([]);
    readFileMock.mockResolvedValue(
      [
        JSON.stringify({
          id: 'e1',
          sessionId: 'session-x',
          type: 'message_created',
          timestamp: '2024-01-01T00:00:00Z',
          cwd: '/project/demo',
          version: '0.0.0',
          data: {
            messageId: 'm1',
            role: 'user',
            createdAt: '2024-01-01T00:00:00Z',
          },
        }),
        JSON.stringify({
          id: 'e2',
          sessionId: 'session-x',
          type: 'part_created',
          timestamp: '2024-01-01T00:00:01Z',
          cwd: '/project/demo',
          version: '0.0.0',
          data: {
            partId: 'p1',
            messageId: 'm1',
            partType: 'text',
            payload: { text: 'Hi' },
            createdAt: '2024-01-01T00:00:01Z',
          },
        }),
        JSON.stringify({
          id: 'e3',
          sessionId: 'session-x',
          type: 'part_created',
          timestamp: '2024-01-01T00:00:02Z',
          cwd: '/project/demo',
          version: '0.0.0',
          data: {
            partId: 'p2',
            messageId: 'm1',
            partType: 'tool_result',
            payload: { toolCallId: 'tool-1', output: { status: 'ok' } },
            createdAt: '2024-01-01T00:00:02Z',
          },
        }),
      ].join('\n')
    );

    const originalResolver = (SessionService as any).getSessionFilePath;
    (SessionService as any).getSessionFilePath = () =>
      '/project/demo/sessions/session-x.jsonl';

    const messages = await SessionService.loadSession('session-x', '/project/demo');

    (SessionService as any).getSessionFilePath = originalResolver;

    expect(readFileMock).toHaveBeenCalledWith(
      '/project/demo/sessions/session-x.jsonl',
      'utf-8'
    );
    expect(messages).toMatchObject([
      { role: 'user', content: 'Hi' },
      {
        role: 'tool',
        content: '{"status":"ok"}',
        tool_call_id: 'tool-1',
        name: undefined,
      },
    ]);
  });

  it('convertJSONLToMessages 应处理消息与工具结果', async () => {
    const messages = SessionService.convertJSONLToMessages([
      {
        id: 'e1',
        sessionId: 'session-y',
        type: 'message_created',
        timestamp: '2024-01-01T00:00:00Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: { messageId: 'm1', role: 'assistant', createdAt: '2024-01-01T00:00:00Z' },
      },
      {
        id: 'e2',
        sessionId: 'session-y',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:01Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'p1',
          messageId: 'm1',
          partType: 'text',
          payload: { text: 'latest' },
          createdAt: '2024-01-01T00:00:01Z',
        },
      },
      {
        id: 'e3',
        sessionId: 'session-y',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:02Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'p2',
          messageId: 'm1',
          partType: 'tool_call',
          payload: {
            toolCallId: 'call',
            toolName: 'Read',
            input: { file_path: 'marker.txt' },
          },
          createdAt: '2024-01-01T00:00:02Z',
        },
      },
      {
        id: 'e4',
        sessionId: 'session-y',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:03Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'p3',
          messageId: 'm1',
          partType: 'tool_result',
          payload: { toolCallId: 'call', toolName: 'Read', output: 'result' },
          createdAt: '2024-01-01T00:00:03Z',
        },
      },
    ] as any);

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        content: 'latest',
        tool_calls: [
          {
            id: 'call',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"marker.txt"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'result',
        tool_call_id: 'call',
        name: 'Read',
      },
    ]);
  });

  it('convertJSONLToMessages 应修复流式工具调用被挂到 user 消息的历史', () => {
    const messages = SessionService.convertJSONLToMessages([
      {
        id: 'e1',
        sessionId: 'session-stream',
        type: 'message_created',
        timestamp: '2024-01-01T00:00:00Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          messageId: 'user-1',
          role: 'user',
          createdAt: '2024-01-01T00:00:00Z',
        },
      },
      {
        id: 'e2',
        sessionId: 'session-stream',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:01Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'text-1',
          messageId: 'user-1',
          partType: 'text',
          payload: { text: 'Read marker.txt' },
          createdAt: '2024-01-01T00:00:01Z',
        },
      },
      {
        id: 'e3',
        sessionId: 'session-stream',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:02Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'call-1',
          messageId: 'user-1',
          partType: 'tool_call',
          payload: {
            toolCallId: 'call-1',
            toolName: 'Read',
            input: { file_path: 'marker.txt' },
          },
          createdAt: '2024-01-01T00:00:02Z',
        },
      },
      {
        id: 'e4',
        sessionId: 'session-stream',
        type: 'part_created',
        timestamp: '2024-01-01T00:00:03Z',
        cwd: '/project/demo',
        version: '0.0.0',
        data: {
          partId: 'call-1',
          messageId: 'call-1',
          partType: 'tool_result',
          payload: {
            toolCallId: 'model-call-1',
            toolName: 'Read',
            output: 'marker-value',
            error: null,
          },
          createdAt: '2024-01-01T00:00:03Z',
        },
      },
    ] as any);

    expect(messages).toMatchObject([
      { role: 'user', content: 'Read marker.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"marker.txt"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'marker-value',
        tool_call_id: 'call-1',
        name: 'Read',
      },
    ]);
  });

  it('listSessionPage propagates root scan permission errors', async () => {
    readdirMock.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    );

    await expect(SessionService.listSessionPage()).rejects.toThrow('denied');
  });

  it('listSessionPage returns an empty page when the storage root is missing', async () => {
    readdirMock.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    );

    await expect(SessionService.listSessionPage()).resolves.toEqual({ sessions: [] });
  });

  it('listSessions skips a corrupt transcript and ignores a transcript removed mid-scan', async () => {
    readdirMock.mockImplementation(async (dir: string, options?: any) => {
      if (dir === '/blade-root/projects' && options?.withFileTypes) {
        return [makeDirent('encodedA', true)];
      }
      if (dir === '/blade-root/projects/encodedA') {
        return ['valid.jsonl', 'corrupt.jsonl', 'gone.jsonl'];
      }
      return [];
    });

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('valid.jsonl')) {
        return [
          JSON.stringify({
            id: 'e1',
            sessionId: 'valid',
            type: 'session_created',
            timestamp: '2024-01-01T00:00:00Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              sessionId: 'valid',
              rootId: 'valid',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            },
          }),
          JSON.stringify({
            id: 'e2',
            sessionId: 'valid',
            type: 'message_created',
            timestamp: '2024-01-01T00:00:01Z',
            cwd: '/projects/encodedA',
            version: '0.0.0',
            data: {
              messageId: 'm1',
              role: 'user',
              createdAt: '2024-01-01T00:00:01Z',
            },
          }),
        ].join('\n');
      }
      if (filePath.endsWith('corrupt.jsonl')) {
        throw new Error('malformed');
      }
      if (filePath.endsWith('gone.jsonl')) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      throw new Error(`unexpected file ${filePath}`);
    });

    await expect(SessionService.listSessions()).resolves.toMatchObject([
      { sessionId: 'valid' },
    ]);
  });

  it('listSessions propagates project and transcript I/O failures', async () => {
    readdirMock.mockImplementation(async (dir: string, options?: any) => {
      if (dir === '/blade-root/projects' && options?.withFileTypes) {
        return [makeDirent('encodedA', true)];
      }
      if (dir === '/blade-root/projects/encodedA') {
        throw Object.assign(new Error('project denied'), { code: 'EACCES' });
      }
      return [];
    });

    await expect(SessionService.listSessions()).rejects.toThrow('project denied');

    readdirMock.mockReset();
    readFileMock.mockReset();
    readdirMock.mockImplementation(async (dir: string, options?: any) => {
      if (dir === '/blade-root/projects' && options?.withFileTypes) {
        return [makeDirent('encodedA', true)];
      }
      if (dir === '/blade-root/projects/encodedA') {
        return ['blocked.jsonl'];
      }
      return [];
    });
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { code: 'EACCES' })
    );

    await expect(SessionService.listSessions()).rejects.toThrow('blocked');
  });
});
