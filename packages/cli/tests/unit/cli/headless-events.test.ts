import { describe, expect, it } from 'vitest';

describe('headless event contract', () => {
  it('exports a stable event version and validates tool events', async () => {
    const {
      HEADLESS_EVENT_VERSION,
      HeadlessJsonlEventSchema,
      createHeadlessJsonlEvent,
    } = await import('../../../src/commands/headlessEvents.js');

    expect(HEADLESS_EVENT_VERSION).toBe(1);

    const event = createHeadlessJsonlEvent('tool_start', {
      tool_name: 'Read',
      summary: 'Reading demo.ts',
      target: '/tmp/demo.ts',
    });

    expect(event).toEqual({
      event_version: 1,
      type: 'tool_start',
      tool_name: 'Read',
      summary: 'Reading demo.ts',
      target: '/tmp/demo.ts',
    });

    expect(() => HeadlessJsonlEventSchema.parse(event)).not.toThrow();
  });

  it('validates phase events for search and target-hit states', async () => {
    const { HeadlessJsonlEventSchema, createHeadlessJsonlEvent } = await import(
      '../../../src/commands/headlessEvents.js'
    );

    const event = createHeadlessJsonlEvent('phase', {
      phase: 'target_hit',
      status: 'hit',
      message: 'Target locked: Editing headless.ts',
      tool_name: 'Edit',
      target: 'packages/cli/src/commands/headless.ts',
    });

    expect(() => HeadlessJsonlEventSchema.parse(event)).not.toThrow();
    expect(event).toEqual({
      event_version: 1,
      type: 'phase',
      phase: 'target_hit',
      status: 'hit',
      message: 'Target locked: Editing headless.ts',
      tool_name: 'Edit',
      target: 'packages/cli/src/commands/headless.ts',
    });
  });
});
