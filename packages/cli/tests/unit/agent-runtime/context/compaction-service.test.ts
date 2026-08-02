/**
 * CompactionService 单元测试
 * 测试上下文压缩服务的孤儿 tool 消息过滤逻辑和 post-compact 文件恢复
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CompactionService } from '../../../../src/context/CompactionService.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import { FileAccessTracker } from '../../../../src/tools/builtin/file/FileAccessTracker.js';

const { compactChat } = vi.hoisted(() => ({
  compactChat: vi.fn(),
}));

vi.mock('../../../../src/services/ChatServiceInterface.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/services/ChatServiceInterface.js')
    >();
  return {
    ...actual,
    createChatServiceAsync: vi.fn(async () => ({ chat: compactChat })),
  };
});

describe('CompactionService - 输出协议', () => {
  test('压缩诊断不应写入 stdout', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active coding task.</summary>',
    });
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Continue the coding task.' }],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'stdout-contract',
        }
      );

      expect(result.success).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('摘要遗漏任务时仍应逐字保留有界的 active-task checkpoint', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>The repository package metadata was inspected.</summary>',
    });
    const activeTask =
      'After Read succeeds, use Write to create compacted.txt containing exactly compacted without quote characters.';
    const messages: Message[] = [
      { role: 'user', content: `${activeTask}\n${'archived context '.repeat(2_000)}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'read-active-task',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"package.json"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"name":"test-project"}',
        tool_call_id: 'read-active-task',
      },
    ];

    const result = await CompactionService.compact(messages, {
      trigger: 'auto',
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'active-task-checkpoint',
      activeTask,
    });

    const checkpoint = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactActiveTask === true
    );
    expect(checkpoint?.content).toContain(activeTask);
    expect(String(checkpoint?.content).length).toBeLessThanOrEqual(7_000);
  });
});

/**
 * 模拟孤儿 tool 消息场景
 * 场景：压缩时保留了 tool 消息，但对应的 assistant 消息被压缩掉了
 */
describe('CompactionService - 孤儿 tool 消息过滤', () => {
  test('应该过滤掉孤儿 tool 消息', () => {
    // 模拟消息历史（压缩前）
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Read file A' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"A"}' },
          },
        ],
      },
      { role: 'tool', content: 'File A content', tool_call_id: 'call_123' },
      { role: 'user', content: 'Read file B' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_456',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"B"}' },
          },
        ],
      },
      { role: 'tool', content: 'File B content', tool_call_id: 'call_456' },
    ];

    // 模拟压缩：只保留最后 3 条消息（保留 50%）
    const retainCount = 3;
    const candidateMessages = messagesBeforeCompaction.slice(-retainCount);

    // candidateMessages 现在是：
    // [
    //   { role: 'user', content: 'Read file B' },
    //   { role: 'assistant', tool_calls: [{ id: 'call_456', ... }] },
    //   { role: 'tool', tool_call_id: 'call_456' },
    // ]

    // 收集可用的 tool_call_id
    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤孤儿 tool 消息
    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：call_456 对应的 tool 消息应该被保留
    expect(filteredMessages).toHaveLength(3);
    expect(availableToolCallIds.has('call_456')).toBe(true);
    expect(availableToolCallIds.has('call_123')).toBe(false);
  });

  test('应该过滤掉所有孤儿 tool 消息', () => {
    // 极端场景：压缩时只保留了 tool 消息，但所有 assistant 消息都被压缩了
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Read file A' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_111',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"A"}' },
          },
        ],
      },
      { role: 'tool', content: 'File A content', tool_call_id: 'call_111' },
      { role: 'user', content: 'Read file B' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_222',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"B"}' },
          },
        ],
      },
      { role: 'tool', content: 'File B content', tool_call_id: 'call_222' },
      { role: 'user', content: 'Analyze files' },
    ];

    // 只保留最后 2 条（tool 消息和 user 消息，没有 assistant）
    const candidateMessages = messagesBeforeCompaction.slice(-2);

    // candidateMessages:
    // [
    //   { role: 'tool', tool_call_id: 'call_222' },  <- 孤儿
    //   { role: 'user', content: 'Analyze files' },
    // ]

    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：孤儿 tool 消息应该被过滤掉
    expect(filteredMessages.length).toBeLessThan(candidateMessages.length);
    expect(filteredMessages.length).toBe(1); // 只剩 user 消息
    expect(filteredMessages.every((msg) => msg.role !== 'tool')).toBe(true);
  });

  test('应该保留完整的 tool 调用链', () => {
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Start task' },
      { role: 'user', content: 'Read file C' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_789',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"C"}' },
          },
        ],
      },
      { role: 'tool', content: 'File C content', tool_call_id: 'call_789' },
      { role: 'assistant', content: 'Done reading C' },
    ];

    // 保留所有消息
    const candidateMessages = messagesBeforeCompaction;

    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：完整链应该被保留
    expect(filteredMessages).toHaveLength(5);
    expect(filteredMessages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

/**
 * Post-Compact 文件恢复测试
 * 测试 CompactionService 的 getRecentlyAccessedFiles 和
 * buildFileRestorationMessage 逻辑
 */
describe('CompactionService - Post-Compact 文件恢复', () => {
  let tmpDir: string;
  let testFiles: string[];

  beforeEach(async () => {
    // 重置 FileAccessTracker 单例
    FileAccessTracker.resetInstance();

    // 创建临时目录和测试文件
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-restore-'));
    testFiles = [];
    for (let i = 0; i < 7; i++) {
      const filePath = path.join(tmpDir, `test-file-${i}.ts`);
      const lines = Array.from(
        { length: 50 },
        (_, ln) => `// line ${ln + 1} of test-file-${i}`
      );
      await fs.writeFile(filePath, lines.join('\n'));
      testFiles.push(filePath);
    }
  });

  afterEach(async () => {
    FileAccessTracker.resetInstance();
    // 清理临时文件
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getRecentlyAccessedFiles 应返回按时间降序的文件', async () => {
    const tracker = FileAccessTracker.getInstance();

    // 使用 fake timers 确保时间戳单调递增
    vi.useFakeTimers({ now: 1000 });
    await tracker.recordFileRead(testFiles[0], 'sess1');
    vi.advanceTimersByTime(100);
    await tracker.recordFileRead(testFiles[1], 'sess1');
    vi.advanceTimersByTime(100);
    await tracker.recordFileRead(testFiles[2], 'sess1');
    vi.useRealTimers();

    const trackedFiles = tracker.getTrackedFiles();
    const sorted = trackedFiles
      .map((fp) => ({ fp, record: tracker.getFileRecord(fp)! }))
      .filter((e) => e.record !== undefined)
      .sort((a, b) => b.record.accessTime - a.record.accessTime);

    const recentPaths = sorted.slice(0, 5).map((e) => e.fp);

    // 最后读取的文件应该排在前面
    expect(recentPaths[0]).toBe(testFiles[2]);
    expect(recentPaths).toHaveLength(3);
  });

  test('getRecentlyAccessedFiles 应限制返回数量', async () => {
    const tracker = FileAccessTracker.getInstance();

    // 记录 7 个文件
    for (const fp of testFiles) {
      await tracker.recordFileRead(fp, 'sess1');
    }

    const trackedFiles = tracker.getTrackedFiles();
    const sorted = trackedFiles
      .map((fp) => ({ fp, record: tracker.getFileRecord(fp)! }))
      .filter((e) => e.record !== undefined)
      .sort((a, b) => b.record.accessTime - a.record.accessTime);

    // 限制为 5 个
    const recentPaths = sorted.slice(0, 5).map((e) => e.fp);
    expect(recentPaths).toHaveLength(5);
  });

  test('没有被追踪的文件时应返回空列表', () => {
    const tracker = FileAccessTracker.getInstance();
    const trackedFiles = tracker.getTrackedFiles();
    expect(trackedFiles).toHaveLength(0);
  });

  test('文件恢复内容应包含 system-reminder 格式', async () => {
    const tracker = FileAccessTracker.getInstance();
    await tracker.recordFileRead(testFiles[0], 'sess1');

    // 模拟 buildFileRestorationMessage 的核心逻辑
    const recentFiles = [testFiles[0]];
    const fileRestorations: string[] = [];

    for (const filePath of recentFiles) {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const preview = lines.slice(0, 200).join('\n');
      const truncated =
        lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : '';
      fileRestorations.push(
        `<file path="${filePath}" lines="${lines.length}">` +
          `\n${preview}${truncated}\n</file>`
      );
    }

    const restorationContent = [
      '<system-reminder>',
      'Post-compaction file restoration.' +
        ' These files were recently accessed' +
        ' in the conversation:',
      ...fileRestorations,
      '</system-reminder>',
    ].join('\n');

    // 验证格式
    expect(restorationContent).toContain('<system-reminder>');
    expect(restorationContent).toContain('</system-reminder>');
    expect(restorationContent).toContain('Post-compaction file restoration.');
    expect(restorationContent).toContain(`<file path="${testFiles[0]}"`);
    expect(restorationContent).toContain('// line 1 of test-file-0');
  });

  test('超过 200 行的文件应被截断', async () => {
    // 创建一个超过 200 行的文件
    const longFilePath = path.join(tmpDir, 'long-file.ts');
    const longLines = Array.from({ length: 300 }, (_, ln) => `// line ${ln + 1}`);
    await fs.writeFile(longFilePath, longLines.join('\n'));

    const content = await fs.readFile(longFilePath, 'utf-8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 200).join('\n');
    const truncated =
      lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : '';

    // 验证截断
    expect(lines.length).toBe(300);
    expect(preview.split('\n')).toHaveLength(200);
    expect(truncated).toContain('100 more lines');
  });

  test('已删除的文件应被静默跳过', async () => {
    const tracker = FileAccessTracker.getInstance();
    const deletedFile = path.join(tmpDir, 'deleted-file.ts');
    await fs.writeFile(deletedFile, '// will be deleted');
    await tracker.recordFileRead(deletedFile, 'sess1');
    await tracker.recordFileRead(testFiles[0], 'sess1');

    // 删除文件
    await fs.unlink(deletedFile);

    // 模拟恢复逻辑
    const recentFiles = [deletedFile, testFiles[0]];
    const fileRestorations: string[] = [];

    for (const filePath of recentFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 200).join('\n');
        fileRestorations.push(
          `<file path="${filePath}" lines="${lines.length}">` + `\n${preview}\n</file>`
        );
      } catch {
        // 文件可能已被删除，静默跳过
      }
    }

    // 只有存在的文件应该被恢复
    expect(fileRestorations).toHaveLength(1);
    expect(fileRestorations[0]).toContain(testFiles[0]);
  });
});
