import { describe, expect, it } from 'vitest';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../src/api/attachmentLimits.js';
import {
  assertLargePromptOffloadEvidence,
  createLargePromptOffloadFixture,
  formatLargePromptProxyDiagnostic,
  inspectLargePromptRequest,
} from '../../integration/real-api/largePromptOffloadHarness.js';
import { parseTokenBudgetHandoffGuiInput } from '../../support/launch-token-budget-handoff-gui.js';

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

  it('preserves an explicit zero retry budget through the Web launcher contract', () => {
    const serialized = JSON.stringify({
      root: '/tmp/large-prompt-web',
      workspace: '/tmp/large-prompt-web/project',
      home: '/tmp/large-prompt-web/home',
      storageRoot: '/tmp/large-prompt-web/storage',
      port: 41_083,
      model: 'deepseek-v4-flash',
      proxyBaseURL: 'http://127.0.0.1:41084',
      maxRetries: 0,
      maxOutputTokens: 1_024,
      temperature: 0,
    });

    expect(
      parseTokenBudgetHandoffGuiInput(
        Buffer.from(serialized, 'utf8').toString('base64')
      )
    ).toMatchObject({
      maxRetries: 0,
      maxOutputTokens: 1_024,
      temperature: 0,
    });
  });

  it('reports bounded Provider facts without retaining request content', () => {
    const diagnostic = formatLargePromptProxyDiagnostic({
      maxInFlight: 1,
      requests: [
        {
          ordinal: 1,
          bodyBytes: 45_000,
          bodySha256: 'a'.repeat(64),
          upstreamStatus: 503,
          responseKind: 'json',
          artifactIds: ['b'.repeat(64)],
          readArtifactIds: [],
          readToolAdvertised: true,
          hasArtifactNotice: true,
          hiddenOccurrences: 0,
          hiddenInToolResult: false,
          hiddenOutsideToolResult: false,
          maxUserTextBytes: 32_000,
        },
      ],
    });

    expect(diagnostic).toBe(
      '{"requestCount":1,"maxInFlight":1,"requests":' +
        '[{"ordinal":1,"status":503,"kind":"json","readCalls":0,' +
        '"hiddenInToolResult":false}]}'
    );
    expect(diagnostic).not.toContain('a'.repeat(64));
    expect(diagnostic).not.toContain('b'.repeat(64));
  });
});
