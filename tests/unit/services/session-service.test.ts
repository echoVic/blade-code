import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.fn();
const readFileMock = vi.fn();

const pathEscapeModulePath = path.resolve(
  path.dirname(fileURLToPath(new URL(import.meta.url))),
  '../../../src/context/storage/pathUtils.js'
);

beforeEach(() => {
  vi.resetModules();
  readdirMock.mockReset();
  readFileMock.mockReset();

  vi.doMock('node:fs/promises', () => ({
    readdir: (...args: any[]) => readdirMock(...args),
    readFile: (...args: any[]) => readFileMock(...args),
  }));

  vi.doMock(pathEscapeModulePath, () => ({
    getBladeStorageRoot: () => '/blade-root',
    unescapeProjectPath: (escaped: string) => `/projects/${escaped}`,
    getSessionFilePath: (projectPath: string, sessionId: string) =>
      `${projectPath}/sessions/${sessionId}.jsonl`,
  }));
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
            type: 'user',
            message: { role: 'user', content: 'hello' },
            timestamp: '2024-01-01T00:00:00Z',
            gitBranch: 'main',
          }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: 'hi' },
            timestamp: '2024-01-01T00:01:00Z',
          }),
        ].join('\n');
      }
      if (filePath.endsWith('session-b.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: 'later' },
            timestamp: '2024-02-01T00:00:00Z',
          }),
          JSON.stringify({
            type: 'tool_result',
            toolResult: { id: 'call-9', error: 'boom' },
            timestamp: '2024-02-01T00:01:00Z',
          }),
        ].join('\n');
      }
      throw new Error(`unexpected file ${filePath}`);
    });

    const { SessionService } = await import('../../../src/services/SessionService.js');
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
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hi' } }),
        JSON.stringify({
          type: 'tool_result',
          toolResult: { id: 'tool-1', output: { status: 'ok' } },
        }),
      ].join('\n')
    );

    const { SessionService } = await import('../../../src/services/SessionService.js');
    const originalResolver = (SessionService as any).getSessionFilePath;
    (SessionService as any).getSessionFilePath = () =>
      '/project/demo/sessions/session-x.jsonl';

    const messages = await SessionService.loadSession('session-x', '/project/demo');

    (SessionService as any).getSessionFilePath = originalResolver;

    expect(readFileMock).toHaveBeenCalledWith(
      '/project/demo/sessions/session-x.jsonl',
      'utf-8'
    );
    expect(messages).toEqual([
      { role: 'user', content: 'Hi' },
      {
        role: 'tool',
        content: '{"status":"ok"}',
        tool_call_id: 'tool-1',
        name: undefined,
      },
    ]);
  });

  it('convertJSONLToMessages 应处理压缩边界与工具结果', async () => {
    const { SessionService } = await import('../../../src/services/SessionService.js');
    const messages = SessionService.convertJSONLToMessages([
      {
        type: 'user',
        message: { role: 'user', content: 'old' },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        message: { role: 'system', content: '' },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'latest' },
      },
      {
        type: 'tool_result',
        toolResult: { id: 'call', output: 'result' },
      },
    ] as any);

    expect(messages).toEqual([
      { role: 'assistant', content: 'latest' },
      { role: 'tool', content: 'result', tool_call_id: 'call', name: undefined },
    ]);
  });
});
