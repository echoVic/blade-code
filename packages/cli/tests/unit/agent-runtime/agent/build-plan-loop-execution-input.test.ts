import { describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { createPlanModeReminder } from '../../../../src/prompts/index.js';

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

describe('buildPlanLoopExecutionInput', () => {
  it('builds the plan-mode system prompt and injects the reminder into the message', async () => {
    buildSystemPromptMock.mockResolvedValue({ prompt: 'plan-system-prompt' });

    const { buildPlanLoopExecutionInput } = await import(
      '../../../../src/agent/buildPlanLoopExecutionInput.js'
    );

    const input = await buildPlanLoopExecutionInput({
      message: 'research this module',
      language: 'zh-CN',
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      language: 'zh-CN',
    });
    expect(input).toEqual({
      systemPrompt: 'plan-system-prompt',
      message: createPlanModeReminder('research this module'),
    });
  });
});
