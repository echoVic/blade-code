import { describe, expect, it } from 'vitest';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../src/api/attachmentLimits.js';
import {
  assertLargePromptOffloadEvidence,
  createLargePromptOffloadFixture,
  inspectLargePromptRequest,
} from '../../integration/real-api/largePromptOffloadHarness.js';

describe('large-prompt offload qualification foundation', () => {
  it('places the hidden authority outside the bounded head and tail preview', () => {
    const fixture = createLargePromptOffloadFixture(
      '/tmp/large-prompt-fixture',
      '0123456789abcdef0123456789abcdef'
    );

    expect(Buffer.byteLength(fixture.prompt)).toBeGreaterThan(
      MAX_INLINE_USER_MESSAGE_TEXT_BYTES
    );
    expect(fixture.prompt).toContain(fixture.hiddenMarker);
    expect(fixture.prompt).not.toContain(fixture.finalMarker);
    expect(fixture.finalMarker).toBe('FINAL_OK_0123456789abcdef0123456789abcdef');
  });

  it('accepts only a bounded initial request followed by the matching tool result', () => {
    const artifactId = 'a'.repeat(64);
    const hiddenMarker = 'PROMPT_ARTIFACT_HIDDEN_test';
    const userContent = [
      '[Full user request stored as a private prompt artifact]',
      `artifact_id=${artifactId}`,
      'Call ReadPromptArtifact before acting.',
    ].join('\n');
    const initial = inspectLargePromptRequest(
      Buffer.from(
        JSON.stringify({
          messages: [{ role: 'user', content: userContent }],
          tools: [{ type: 'function', function: { name: 'ReadPromptArtifact' } }],
        })
      ),
      hiddenMarker,
      1
    );
    const revealed = inspectLargePromptRequest(
      Buffer.from(
        JSON.stringify({
          messages: [
            { role: 'user', content: userContent },
            {
              role: 'assistant',
              tool_calls: [
                {
                  function: {
                    name: 'ReadPromptArtifact',
                    arguments: JSON.stringify({ artifact_id: artifactId }),
                  },
                },
              ],
            },
            { role: 'tool', content: `chunk ${hiddenMarker}` },
          ],
          tools: [{ type: 'function', function: { name: 'ReadPromptArtifact' } }],
        })
      ),
      hiddenMarker,
      2
    );

    expect(() =>
      assertLargePromptOffloadEvidence({
        requests: [initial, revealed],
        maxInFlight: 1,
      })
    ).not.toThrow();
    expect(() =>
      assertLargePromptOffloadEvidence({
        requests: [
          {
            ...initial,
            hiddenOccurrences: 1,
            hiddenOutsideToolResult: true,
          },
          revealed,
        ],
        maxInFlight: 1,
      })
    ).toThrow('first Provider request');
  });
});
