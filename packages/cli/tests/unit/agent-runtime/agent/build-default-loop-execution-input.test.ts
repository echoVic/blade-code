import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildSystemPromptMock } = vi.hoisted(() => ({
  buildSystemPromptMock: vi.fn(),
}));

vi.mock('../../../../src/prompts/index.js', async () => {
  const actual = await vi.importActual('../../../../src/prompts/index.js');
  return {
    ...actual,
    buildSystemPrompt: buildSystemPromptMock,
  };
});

describe('buildDefaultLoopExecutionInput', () => {
  beforeEach(() => {
    buildSystemPromptMock.mockReset();
  });

  it('prefers the context system prompt without rebuilding it', async () => {
    const { buildDefaultLoopExecutionInput } = await import(
      '../../../../src/agent/buildDefaultLoopExecutionInput.js'
    );

    const input = await buildDefaultLoopExecutionInput({
      message: 'hello',
      contextSystemPrompt: 'context-prompt',
      runtimeSystemPrompt: 'ignored-replace',
      runtimeAppendSystemPrompt: 'ignored-append',
      language: 'zh-CN',
      environmentContext: 'ENV',
    });

    expect(buildSystemPromptMock).not.toHaveBeenCalled();
    expect(input).toEqual({
      message: 'hello',
      systemPrompt: 'ENV\n\n---\n\ncontext-prompt',
    });
  });

  it('builds a runtime system prompt when the context does not provide one', async () => {
    buildSystemPromptMock.mockResolvedValue({ prompt: 'runtime-prompt' });

    const { buildDefaultLoopExecutionInput } = await import(
      '../../../../src/agent/buildDefaultLoopExecutionInput.js'
    );

    const input = await buildDefaultLoopExecutionInput({
      message: 'hello',
      contextSystemPrompt: undefined,
      runtimeSystemPrompt: 'replace-default',
      runtimeAppendSystemPrompt: 'append-default',
      language: 'zh-CN',
      environmentContext: 'ENV',
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      replaceDefault: 'replace-default',
      append: 'append-default',
      includeEnvironment: false,
      language: 'zh-CN',
    });
    expect(input).toEqual({
      message: 'hello',
      systemPrompt: 'ENV\n\n---\n\nruntime-prompt',
    });
  });
});
