export const SIDE_CONVERSATION_COMMAND = 'btw';
export const MAX_SIDE_QUESTION_CHARS = 16 * 1024;

export interface ParsedSideConversationCommand {
  question: string;
}

export function parseSideConversationCommand(
  input: string
): ParsedSideConversationCommand | undefined {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?\s*$/iu.exec(input);
  if (!match) return undefined;
  return { question: (match[1] ?? '').trim() };
}
