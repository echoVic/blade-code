/**
 * CompactionService 单元测试
 * 测试上下文压缩服务的孤儿 tool 消息过滤逻辑
 */

import { describe, expect, test } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';

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
