import { afterEach, expect, it, vi } from 'vitest';
import { generateConversationRecap } from '../../../src/agent/loop/conversationRecap.js';
import type { LoopDependencies } from '../../../src/agent/loop/types.js';
import type { ChatContext } from '../../../src/agent/types.js';
import type { IChatService } from '../../../src/services/ChatServiceInterface.js';

afterEach(() => vi.useRealTimers());

it.each(['deadline', 'cancel'] as const)(
  'cancels an in-flight recap at %s and never publishes late output',
  async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const chat = vi.fn<IChatService['chat']>(async (_messages, _tools, signal) => {
      providerSignal = signal;
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true })
      );
      return { content: 'Late output' };
    });
    const deps = {
      config: { language: 'en' },
      chatService: { chat, getConfig: () => ({ maxContextTokens: 128000 }) },
    } as unknown as LoopDependencies;
    const context: ChatContext = {
      sessionId: 's',
      userId: 'test',
      workspaceRoot: '/workspace',
      messages: [{ role: 'user', content: 'Finish the work.' }],
    };
    const request = generateConversationRecap(
      deps,
      context,
      null,
      vi.fn(),
      controller.signal
    ).next();
    expect(chat).toHaveBeenCalledOnce();
    const settled =
      reason === 'cancel'
        ? expect(request).rejects.toThrow()
        : expect(request).resolves.toMatchObject({ done: true });
    if (reason === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    await settled;
    expect(providerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
);
