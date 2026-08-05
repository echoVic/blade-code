import type { Api, Context, Model, Models } from '@earendil-works/pi-ai';
import type { StreamChunk } from '../ChatServiceInterface.js';
import { convertPiUsage } from './requestOptions.js';

export async function* streamPiModel(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: Record<string, unknown>
): AsyncGenerator<StreamChunk, void, unknown> {
  const stream = models.stream(model, context, options as never);
  let toolCallIndex = 0;

  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        yield { content: event.delta };
        break;
      case 'thinking_delta':
        yield { reasoningContent: event.delta };
        break;
      case 'toolcall_end':
        yield {
          toolCalls: [
            {
              index: toolCallIndex++,
              id: event.toolCall.id,
              type: 'function',
              function: {
                name: event.toolCall.name,
                arguments: JSON.stringify(event.toolCall.arguments),
              },
            },
          ],
        };
        break;
      case 'done':
        yield {
          finishReason: event.reason,
          usage: convertPiUsage(event.message.usage),
        };
        break;
      case 'error':
        throw new Error(
          event.error.errorMessage ??
            `Request ${event.reason === 'aborted' ? 'aborted' : 'failed'}`
        );
    }
  }
}
