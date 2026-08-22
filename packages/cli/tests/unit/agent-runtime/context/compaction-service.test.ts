/**
 * CompactionService 单元测试
 * 测试上下文压缩服务的孤儿 tool 消息过滤逻辑和 post-compact 文件恢复
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildCompactionPrompt,
  type CompactionOptions,
  CompactionService,
  extractExactContinuationRecords,
  reconcileExactContinuationRecords,
  resetCompactionCircuitBreaker,
} from '../../../../src/context/CompactionService.js';
import type { FileContent } from '../../../../src/context/FileAnalyzer.js';
import {
  isTokenBudgetHandoffMessage,
  projectTokenBudgetHandoffEvent,
  stripTokenBudgetHandoffMessages,
} from '../../../../src/context/TokenBudgetHandoff.js';
import { TokenCounter } from '../../../../src/context/TokenCounter.js';
import type { TokenBudgetHandoffRecordedEvent } from '../../../../src/context/types.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import {
  createChatServiceAsync,
  type Message,
} from '../../../../src/services/ChatServiceInterface.js';
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

function validHandoffEvent(): TokenBudgetHandoffRecordedEvent {
  return {
    id: 'handoff-event-1',
    sessionId: 'token-budget-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/tmp/token-budget-compaction',
    version: 'test',
    data: {
      version: 1,
      messageId: 'handoff-message-1',
      observedPromptTokens: 70_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  } satisfies TokenBudgetHandoffRecordedEvent;
}

function projectedHandoff(): Message {
  const marker = projectTokenBudgetHandoffEvent(validHandoffEvent());
  if (!marker) {
    throw new Error('Expected a valid token-budget handoff marker fixture');
  }
  return marker;
}

function markerRetainedSourceMessages(marker: Message): Message[] {
  return [
    { role: 'user', content: 'before-1' },
    { role: 'assistant', content: 'before-2' },
    { role: 'user', content: 'before-3' },
    { role: 'assistant', content: 'before-4' },
    marker,
    { role: 'assistant', content: 'after' },
  ];
}

const markerCompactionOptions: CompactionOptions = {
  trigger: 'auto',
  modelName: 'test-model',
  maxContextTokens: 128_000,
  apiKey: 'test-key',
  baseURL: 'https://example.invalid',
  workspaceRoot: '/tmp/token-budget-compaction',
  sessionId: 'token-budget-session',
};

describe('CompactionService - 输出协议', () => {
  test('摘要请求应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    await CompactionService.compact(sourceMessages, markerCompactionOptions);

    const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
    expect(prompt).not.toContain(String(marker.content));
  });

  test('LLM replacement 应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    const result = await CompactionService.compact(
      sourceMessages,
      markerCompactionOptions
    );

    expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
  });

  test('marker 被剥离后 actual usage 不得旁路进入 token count 或 hook', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    const filteredMessages = stripTokenBudgetHandoffMessages(sourceMessages);
    const expectedPreTokens = TokenCounter.countTokens(
      filteredMessages,
      markerCompactionOptions.modelName
    );
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({ blockCompaction: false });
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    try {
      const result = await CompactionService.compact(sourceMessages, {
        ...markerCompactionOptions,
        actualPreTokens: 99_999,
      });

      expect(result.preTokens).toBe(expectedPreTokens);
      expect(hookSpy).toHaveBeenCalledWith(
        'auto',
        expect.objectContaining({
          messagesBefore: filteredMessages.length,
          tokensBefore: expectedPreTokens,
        })
      );
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('hook 明确阻止压缩时不得形成无 marker checkpoint', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({
        blockCompaction: true,
        blockReason: 'policy denied compaction',
      });

    try {
      await expect(
        CompactionService.compact(sourceMessages, markerCompactionOptions)
      ).rejects.toThrow('policy denied compaction');
      expect(compactChat).not.toHaveBeenCalled();
      expect(sourceMessages.some(isTokenBudgetHandoffMessage)).toBe(true);
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('deterministic fallback replacement 应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(
      sourceMessages,
      markerCompactionOptions
    );

    expect(result.success).toBe(false);
    expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
  });

  test('continuation ledger prompt 应精确声明七段执行交接契约', () => {
    const fileContents: FileContent[] = [
      {
        path: 'src/frontier.ts',
        content: 'export const frontier = true;',
        truncated: false,
        lines: 1,
        includedLines: 1,
      },
    ];
    const prompt = buildCompactionPrompt(
      [{ role: 'user', content: 'Run `bun run type-check` after setting MODE=exact.' }],
      fileContents
    );
    const headings = [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ];

    for (const heading of headings) {
      expect(prompt.match(new RegExp(heading, 'g'))).toHaveLength(1);
      expect(prompt).toContain(`## ${heading}`);
    }
    expect(prompt).toContain('distinguish observed facts from intended work');
    expect(prompt).toContain(
      'preserve exact commands, tool arguments, and final-response constraints when necessary for continuation'
    );
    expect(prompt).toContain('never invent successful verification');
    expect(prompt).toContain('never mark unfinished work complete');
    expect(prompt).toContain('never convert a plan into a completed mutation');
    expect(prompt).toContain('never include credentials or hidden control messages');
    expect(prompt).toContain('never include raw reasoning');
    expect(prompt).toContain(
      'explicitly labels a literal as an exact continuation record and names one of the seven ledger headings'
    );
    expect(prompt).toContain(
      'copy that literal verbatim as one standalone list item under the named heading'
    );
    expect(prompt).toContain('EXACT CONTINUATION RECORD [<heading>] :: <payload>');
    expect(prompt).toContain(
      'Only <payload>, the text after the exact delimiter :: , belongs in the ledger item'
    );
    expect(prompt).toContain(
      'Do not omit, rewrite, split, decorate, relocate, reorder, or append text to an exact continuation record'
    );
    expect(prompt).toContain(
      'Do not infer or auto-repair a missing record, payload, status, or heading assignment'
    );
    expect(prompt).not.toContain('identifier beginning MUTATION_');
    expect(prompt).not.toContain('identifier beginning FAILED_');
    expect(prompt).not.toContain('identifier beginning PENDING_');
    expect(prompt).toContain('`bun run type-check`');
    expect(prompt).toContain('MODE=exact');
    expect(prompt).toContain('<analysis>');
    expect(prompt).toContain('<summary>');
  });

  test('continuation ledger generation 应使用 deterministic temperature', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    await CompactionService.compact(
      [{ role: 'user', content: 'preserve the execution frontier' }],
      markerCompactionOptions
    );

    expect(createChatServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 })
    );
  });

  test('host 应逐字归位 exact continuation records 并移除模型副本', () => {
    const pending = 'PENDING_A1B2C3D4 status=pending';
    const action =
      'PRIOR_WRITE_COMPLETE; RUN_ONLY_EXACT_BASH="bun test"; REQUIRE_ZERO_EXIT';
    const source: Message[] = [
      {
        role: 'user',
        content: [
          `EXACT CONTINUATION RECORD [Exact next action] :: ${pending}`,
          `EXACT CONTINUATION RECORD [Exact next action] :: ${action}`,
          `EXACT CONTINUATION RECORD [Exact next action] :: ${pending}`,
        ].join('\n'),
      },
    ];
    const generated = [
      '## Objective and constraints',
      'Continue.',
      '## Active tasks and background work',
      `- ${pending}`,
      '## Exact next action',
      `- ${action}`,
    ].join('\n');

    const reconciled = reconcileExactContinuationRecords(generated, source);

    for (const heading of [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ]) {
      expect(reconciled.match(new RegExp(`^## ${heading}$`, 'gm'))).toHaveLength(1);
    }
    expect(reconciled.split(pending)).toHaveLength(2);
    expect(reconciled.split(action)).toHaveLength(2);
    expect(reconciled.indexOf(pending)).toBeGreaterThan(
      reconciled.indexOf('## Exact next action')
    );
  });

  test('host 不从旧 compact summary 或未知 heading 继承 exact records', () => {
    const priorSummary: Message = {
      role: 'user',
      content: 'EXACT CONTINUATION RECORD [Exact next action] :: PRIOR status=pending',
      metadata: { isCompactSummary: true },
    };
    const source: Message[] = [
      priorSummary,
      {
        role: 'user',
        content: [
          'EXACT CONTINUATION RECORD [Unknown] :: ignored',
          'EXACT CONTINUATION RECORD [Exact next action] :: CURRENT status=pending',
        ].join('\n'),
      },
    ];

    expect(extractExactContinuationRecords(source)).toEqual([
      {
        heading: 'Exact next action',
        payload: 'CURRENT status=pending',
      },
    ]);
  });

  test('旧 compact summary 不得让 reserved ledger headings 在 prompt 中重复', () => {
    const headings = [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ];
    const prompt = buildCompactionPrompt(
      [
        {
          role: 'user',
          content: headings.join('\n'),
          metadata: { isCompactSummary: true },
        },
      ],
      []
    );

    for (const heading of headings) {
      expect(prompt.match(new RegExp(heading, 'g'))).toHaveLength(1);
      expect(prompt).toContain(`## ${heading}`);
    }
    expect(prompt).toContain('Objective\\u0020and\\u0020constraints');
  });

  test('compaction hook 应使用 active workspace', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active workspace.</summary>',
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        costUsd: 0.125,
      },
    });
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({ blockCompaction: false });

    try {
      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Continue the worktree task.' }],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'hook-workspace-session',
          workspaceRoot: '/tmp/active-worktree',
        }
      );

      expect(hookSpy).toHaveBeenCalledWith(
        'auto',
        expect.objectContaining({
          projectDir: '/tmp/active-worktree',
          sessionId: 'hook-workspace-session',
        })
      );
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        costUsd: 0.125,
      });
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('circuit breaker 应按 workspace 和 session 复合身份隔离', async () => {
    resetCompactionCircuitBreaker();
    compactChat
      .mockRejectedValueOnce(new Error('workspace-a failure 1'))
      .mockRejectedValueOnce(new Error('workspace-a failure 2'))
      .mockRejectedValueOnce(new Error('workspace-a failure 3'))
      .mockResolvedValueOnce({
        content: '<summary>Workspace B remains independent.</summary>',
      });
    const commonOptions = {
      trigger: 'auto' as const,
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'duplicate-session-id',
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await CompactionService.compact(
          [{ role: 'user', content: `Workspace A attempt ${attempt}` }],
          { ...commonOptions, workspaceRoot: '/tmp/workspace-a' }
        );
        expect(result.success).toBe(false);
      }

      const workspaceBResult = await CompactionService.compact(
        [{ role: 'user', content: 'Workspace B attempt' }],
        { ...commonOptions, workspaceRoot: '/tmp/workspace-b' }
      );

      expect(workspaceBResult.success).toBe(true);
      expect(compactChat).toHaveBeenCalledTimes(4);
    } finally {
      resetCompactionCircuitBreaker();
    }
  });

  test('circuit breaker 应规范化等价的 workspace 路径', async () => {
    resetCompactionCircuitBreaker();
    compactChat
      .mockRejectedValueOnce(new Error('failure 1'))
      .mockRejectedValueOnce(new Error('failure 2'))
      .mockRejectedValueOnce(new Error('failure 3'))
      .mockResolvedValueOnce({ content: '<summary>must not run</summary>' });
    const options = {
      trigger: 'auto' as const,
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'canonical-session',
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await CompactionService.compact(
          [{ role: 'user', content: `Attempt ${attempt}` }],
          { ...options, workspaceRoot: '/tmp/canonical-workspace' }
        );
      }

      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Equivalent path attempt' }],
        { ...options, workspaceRoot: '/tmp/canonical-workspace/.' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Circuit breaker open');
      expect(compactChat).toHaveBeenCalledTimes(3);
    } finally {
      resetCompactionCircuitBreaker();
    }
  });

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

  test('应从 active workspace 读取相对路径的重点文件', async () => {
    const activeWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), 'compaction-worktree-')
    );
    await fs.mkdir(path.join(activeWorkspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(activeWorkspace, 'src', 'clamp.js'),
      "export const location = 'managed-worktree';\n"
    );
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the managed worktree change.</summary>',
    });

    try {
      await CompactionService.compact(
        [
          { role: 'user', content: 'Fix src/clamp.js in the managed worktree.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'edit-clamp',
                type: 'function',
                function: {
                  name: 'Edit',
                  arguments: '{\"file_path\":\"src/clamp.js\"}',
                },
              },
            ],
          },
        ],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'managed-worktree-files',
          workspaceRoot: activeWorkspace,
        }
      );

      const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
      expect(prompt).toContain("export const location = 'managed-worktree';");
    } finally {
      await fs.rm(activeWorkspace, { recursive: true, force: true });
    }
  });

  test('不应读取 active workspace 外的相对路径或符号链接', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-boundary-'));
    const activeWorkspace = path.join(tempRoot, 'worktree');
    const outsideWorkspace = path.join(tempRoot, 'outside');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(outsideWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(outsideWorkspace, 'lexical-secret.ts'),
      "export const lexicalSecret = 'must-not-leak';\n"
    );
    await fs.writeFile(
      path.join(outsideWorkspace, 'symlink-secret.ts'),
      "export const symlinkSecret = 'must-not-leak';\n"
    );
    await fs.symlink(outsideWorkspace, path.join(activeWorkspace, 'linked'));
    compactChat.mockResolvedValueOnce({
      content: '<summary>Keep worktree isolation.</summary>',
    });

    try {
      const result = await CompactionService.compact(
        [
          {
            role: 'user',
            content:
              'Do not restore ../outside/lexical-secret.ts or ' +
              'linked/symlink-secret.ts.',
          },
        ],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'managed-worktree-boundary',
          workspaceRoot: activeWorkspace,
        }
      );

      const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
      expect(prompt).not.toContain("export const lexicalSecret = 'must-not-leak';");
      expect(prompt).not.toContain("export const symlinkSecret = 'must-not-leak';");
      expect(result.filesIncluded).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
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

  test('只恢复当前 session 的 active workspace 文件', async () => {
    const tracker = FileAccessTracker.getInstance();
    const activeWorkspace = path.join(tmpDir, 'active-worktree');
    const siblingWorkspace = path.join(tmpDir, 'original-checkout');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(siblingWorkspace, { recursive: true });
    const activeFile = path.join(activeWorkspace, 'active.ts');
    const siblingFile = path.join(siblingWorkspace, 'sibling.ts');
    const foreignSessionFile = path.join(activeWorkspace, 'foreign.ts');
    await fs.writeFile(activeFile, 'export const active = true;');
    await fs.writeFile(siblingFile, "export const sibling = 'must-not-leak';");
    await fs.writeFile(
      foreignSessionFile,
      "export const foreignSession = 'must-not-leak';"
    );
    await tracker.recordFileRead(activeFile, 'current-session');
    await tracker.recordFileRead(siblingFile, 'current-session');
    await tracker.recordFileRead(foreignSessionFile, 'foreign-session');
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve only active workspace context.</summary>',
    });

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'Continue the active worktree task.' }],
      {
        trigger: 'auto',
        modelName: 'test-model',
        maxContextTokens: 6_000,
        apiKey: 'test-key',
        baseURL: 'https://example.invalid',
        sessionId: 'current-session',
        workspaceRoot: activeWorkspace,
      }
    );

    const restoration = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactRestoration === true
    );
    expect(restoration?.content).toContain('export const active = true;');
    expect(restoration?.content).not.toContain('must-not-leak');
  });

  test('workspace 过滤应在最近文件上限之前发生', async () => {
    const tracker = FileAccessTracker.getInstance();
    const activeWorkspace = path.join(tmpDir, 'limited-active-worktree');
    const siblingWorkspace = path.join(tmpDir, 'limited-sibling-worktree');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(siblingWorkspace, { recursive: true });
    const activeFile = path.join(activeWorkspace, 'active.ts');
    await fs.writeFile(activeFile, 'export const retained = true;');
    await tracker.recordFileRead(activeFile, 'shared-session');
    for (let index = 0; index < 5; index++) {
      const siblingFile = path.join(siblingWorkspace, `newer-${index}.ts`);
      await fs.writeFile(siblingFile, `export const sibling${index} = true;`);
      await tracker.recordFileRead(siblingFile, 'shared-session');
    }
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active workspace file.</summary>',
    });

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'Continue the active task.' }],
      {
        trigger: 'auto',
        modelName: 'test-model',
        maxContextTokens: 6_000,
        apiKey: 'test-key',
        baseURL: 'https://example.invalid',
        sessionId: 'shared-session',
        workspaceRoot: activeWorkspace,
      }
    );

    const restoration = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactRestoration === true
    );
    expect(restoration?.content).toContain('export const retained = true;');
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
