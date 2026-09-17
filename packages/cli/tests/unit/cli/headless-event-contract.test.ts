import { describe, expect, it } from 'vitest';
import {
  createHeadlessJsonlEvent,
  HEADLESS_EVENT_VERSION,
  HeadlessJsonlEventSchema,
} from '../../../src/commands/headlessEvents.js';

describe('headless JSONL event contract', () => {
  it('versions and validates constructed events', () => {
    const events = [
      createHeadlessJsonlEvent('phase', {
        phase: 'completed',
        status: 'done',
        message: 'Headless run completed',
      }),
      createHeadlessJsonlEvent('tool_start', {
        tool_name: 'Read',
        summary: 'Reading source',
        target: '/workspace/source.ts',
      }),
      createHeadlessJsonlEvent('provider_retry', {
        phase: 'scheduled',
        attempt: 1,
        max_retries: 2,
        reason: 'server_error',
        status_code: 503,
        delay_ms: 750,
        next_retry_at: 1_750,
      }),
    ];

    expect(HEADLESS_EVENT_VERSION).toBe(1);
    for (const event of events) {
      expect(event.event_version).toBe(HEADLESS_EVENT_VERSION);
      expect(() => HeadlessJsonlEventSchema.parse(event)).not.toThrow();
    }
  });

  it('rejects incompatible versions and invalid event payloads', () => {
    expect(() =>
      HeadlessJsonlEventSchema.parse({
        event_version: HEADLESS_EVENT_VERSION + 1,
        type: 'phase',
        phase: 'completed',
        status: 'done',
        message: 'incompatible',
      })
    ).toThrow();
    expect(() =>
      HeadlessJsonlEventSchema.parse({
        event_version: HEADLESS_EVENT_VERSION,
        type: 'provider_retry',
        phase: 'waiting',
        attempt: 1,
        max_retries: 2,
        reason: 'server_error',
        recovery_remaining_ms: -1,
      })
    ).toThrow();
  });
});
