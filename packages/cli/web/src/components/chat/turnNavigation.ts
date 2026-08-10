import type { Message } from '@/services';

export interface ChatTurn {
  id: string;
  index: number;
  preview: string;
}

const MAX_PREVIEW_LENGTH = 80;

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join(' ');
}

/**
 * Collapse a user prompt into a single-line preview for the turn rail.
 * Strips common slash-command wrappers and normalises whitespace.
 */
export function turnPreview(content: Message['content']): string {
  const raw = extractText(content).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > MAX_PREVIEW_LENGTH
    ? `${raw.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : raw;
}

/**
 * Derive the ordered list of user turns from the full message list.
 * Only user messages that carry a stable id and non-empty preview qualify,
 * because the rail needs a scroll target and a label per entry.
 */
export function deriveChatTurns(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (!message.id) continue;
    const preview = turnPreview(message.content);
    if (!preview) continue;
    turns.push({ id: message.id, index, preview });
  }
  return turns;
}
