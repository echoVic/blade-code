import type { UserPromptArtifactStore } from '../../../agent/runtime/UserPromptArtifactStore.js';
import {
  DEFAULT_USER_PROMPT_ARTIFACT_READ_BYTES,
  MAX_USER_PROMPT_ARTIFACT_READ_BYTES,
} from '../../../agent/runtime/UserPromptArtifactStore.js';
import { Default, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

export function createReadPromptArtifactTool(store: UserPromptArtifactStore) {
  return createTool({
    name: 'ReadPromptArtifact',
    displayName: 'Read Prompt Artifact',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    isRetrySafe: true,

    schema: Type.Object({
      artifact_id: Type.String({
        pattern: '^[a-f0-9]{64}$',
        description: 'Opaque artifact ID from an offloaded user request',
      }),
      offset: Default(
        Type.Integer({
          minimum: 0,
          description: 'UTF-8 byte offset to start reading from',
        }),
        0
      ),
      limit: Default(
        Type.Integer({
          minimum: 4,
          maximum: MAX_USER_PROMPT_ARTIFACT_READ_BYTES,
          description: 'Maximum UTF-8 bytes to return',
        }),
        DEFAULT_USER_PROMPT_ARTIFACT_READ_BYTES
      ),
    }),

    description: {
      short: 'Read a private user-prompt artifact',
      long:
        'Reads a bounded chunk of a large user request that Blade stored outside ' +
        'the model context. The artifact is scoped to the current Session.',
      usageNotes: [
        'Use the artifact_id exactly as provided in the user message',
        'Continue with next_offset until the complete request has been read',
        'Offsets are UTF-8 byte offsets, not line numbers',
      ],
      important: [
        'Read every required chunk before acting on an offloaded request',
        'Do not guess content omitted from the inline preview',
      ],
    },

    async execute({ artifact_id, offset, limit }) {
      try {
        const chunk = await store.read(artifact_id, offset, limit);
        const continuation =
          chunk.nextOffset === undefined
            ? '\n\n[End of prompt artifact]'
            : `\n\n[Continue with offset=${chunk.nextOffset}]`;
        return {
          success: true,
          llmContent: `${chunk.content}${continuation}`,
          metadata: {
            summary:
              chunk.nextOffset === undefined
                ? 'Read final prompt artifact chunk'
                : 'Read prompt artifact chunk',
            artifact_id: chunk.id,
            size_bytes: chunk.sizeBytes,
            offset: chunk.offset,
            returned_bytes: chunk.returnedBytes,
            next_offset: chunk.nextOffset,
          },
        };
      } catch (error) {
        const message = 'Prompt artifact is unavailable or invalid';
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof (error as NodeJS.ErrnoException).code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        return {
          success: false,
          llmContent: `Prompt artifact read failed: ${message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message,
            code,
          },
          metadata: {
            summary: 'Prompt artifact read failed',
          },
        };
      }
    },

    version: '1.0.0',
    category: 'system',
    tags: ['prompt', 'artifact', 'context'],
    extractSignatureContent: ({ artifact_id }) => artifact_id,
  });
}
