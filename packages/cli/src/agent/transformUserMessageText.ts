import type { ContentPart } from '../services/ChatServiceInterface.js';
import type { UserMessageContent } from './types.js';

export function transformUserMessageText(
  message: UserMessageContent,
  transform: (text: string) => string
): UserMessageContent {
  if (typeof message === 'string') {
    return transform(message);
  }

  const firstTextPart = message.find(
    (part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text'
  );

  if (!firstTextPart) {
    return [{ type: 'text', text: transform('') }, ...message];
  }

  return message.map((part) =>
    part === firstTextPart
      ? {
          ...firstTextPart,
          text: transform(firstTextPart.text),
        }
      : part
  );
}
