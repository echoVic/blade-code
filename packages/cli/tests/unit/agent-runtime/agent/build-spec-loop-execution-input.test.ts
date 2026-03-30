import { describe, expect, it } from 'vitest';

import { buildSpecModePrompt, createSpecModeReminder } from '../../../../src/prompts/spec.js';
import type { SpecMetadata } from '../../../../src/spec/types.js';

describe('buildSpecLoopExecutionInput', () => {
  it('builds the spec-mode system prompt and injects the phase reminder into the message', async () => {
    const { buildSpecLoopExecutionInput } = await import(
      '../../../../src/agent/buildSpecLoopExecutionInput.js'
    );

    const currentSpec: SpecMetadata = {
      id: 'spec-1',
      name: 'agent-loop',
      description: 'Refactor the agent loop',
      phase: 'design',
      createdAt: '2026-03-26T00:00:00.000Z',
      updatedAt: '2026-03-26T01:00:00.000Z',
      tasks: [],
    };

    const input = buildSpecLoopExecutionInput({
      message: 'continue',
      currentSpec,
      steeringContext: 'follow project architecture',
    });

    expect(input).toEqual({
      systemPrompt: buildSpecModePrompt(currentSpec, 'follow project architecture'),
      message: `${createSpecModeReminder('design')}\n\ncontinue`,
    });
  });

  it('defaults to the init phase when there is no current spec and prepends text for image-only messages', async () => {
    const { buildSpecLoopExecutionInput } = await import(
      '../../../../src/agent/buildSpecLoopExecutionInput.js'
    );

    const imageOnlyMessage = [
      { type: 'image_url', image_url: { url: 'https://example.com/spec.png' } },
    ] as const;

    const input = buildSpecLoopExecutionInput({
      message: imageOnlyMessage as any,
      currentSpec: null,
      steeringContext: null,
    });

    expect(input.systemPrompt).toBe(buildSpecModePrompt(null, null));
    expect(input.message).toEqual([
      { type: 'text', text: createSpecModeReminder('init') + '\n\n' },
      ...imageOnlyMessage,
    ]);
  });
});
