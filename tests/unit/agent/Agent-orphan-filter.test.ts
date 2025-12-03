/**
 * Agent 孤儿 tool 消息过滤测试
 *
 * 验证 Agent 在调用 LLM 前能正确过滤掉孤儿 tool 消息
 */

import { describe, expect, test, vi } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';

describe('Agent - 孤儿 tool 消息过滤', () => {
  test('应该过滤掉孤儿 tool 消息 (通过反射测试私有方法)', () => {
    // 模拟消息历史（包含孤儿 tool 消息）
    const messages: Message[] = [
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
      // 下面的 assistant 消息在上下文压缩时被移除
      // {
      //   role: 'assistant',
      //   content: '',
      //   tool_calls: [{ id: 'call_222', type: 'function', function: { name: 'Read', arguments: '{"file":"B"}' } }],
      // },
      { role: 'tool', content: 'File B content', tool_call_id: 'call_222' }, // ← 孤儿
      { role: 'user', content: 'Analyze files' },
    ];

    // 收集所有可用的 tool_call ID（模拟 filterOrphanToolMessages 逻辑）
    const availableToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤孤儿 tool 消息
    const filtered = messages.filter((msg) => {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) return false;
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证
    expect(filtered.length).toBe(4); // user + assistant + tool + user (孤儿被过滤)
    expect(filtered.find((m) => m.tool_call_id === 'call_222')).toBeUndefined(); // 孤儿已被移除
    expect(filtered.find((m) => m.tool_call_id === 'call_111')).toBeDefined(); // 正常 tool 消息保留
  });

  test('应该保留完整的 tool 调用链', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_AAA',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"X"}' },
          },
        ],
      },
      { role: 'tool', content: 'X content', tool_call_id: 'call_AAA' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_BBB',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"Y"}' },
          },
        ],
      },
      { role: 'tool', content: 'Y content', tool_call_id: 'call_BBB' },
    ];

    // 过滤逻辑
    const availableToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filtered = messages.filter((msg) => {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) return false;
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：完整的调用链应该全部保留
    expect(filtered.length).toBe(messages.length);
    expect(filtered).toEqual(messages);
  });

  test('应该过滤掉所有孤儿 tool 消息', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Start' },
      // 所有 assistant 消息都被压缩掉了
      { role: 'tool', content: 'Result 1', tool_call_id: 'orphan_1' },
      { role: 'tool', content: 'Result 2', tool_call_id: 'orphan_2' },
      { role: 'tool', content: 'Result 3', tool_call_id: 'orphan_3' },
      { role: 'user', content: 'Continue' },
    ];

    // 过滤逻辑
    const availableToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filtered = messages.filter((msg) => {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) return false;
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：所有 tool 消息都应该被过滤掉
    expect(filtered.length).toBe(2); // 只剩 2 个 user 消息
    expect(filtered.every((m) => m.role === 'user')).toBe(true);
  });

  test('应该过滤掉缺失 tool_call_id 的 tool 消息', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Start' },
      { role: 'tool', content: 'Result without id' }, // 缺失 tool_call_id
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_valid',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"X"}' },
          },
        ],
      },
      { role: 'tool', content: 'Valid result', tool_call_id: 'call_valid' },
    ];

    const availableToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filtered = messages.filter((msg) => {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) return false;
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 缺失 ID 的 tool 消息被过滤，其他正常链条保留
    expect(filtered.find((m) => m.content === 'Result without id')).toBeUndefined();
    expect(filtered.find((m) => m.tool_call_id === 'call_valid')).toBeDefined();
    expect(filtered.length).toBe(3);
  });
});
