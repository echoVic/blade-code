import { nanoid } from 'nanoid';

export interface MessageFactoryOptions {
  id?: string;
  timestamp?: number;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | {
            type: 'tool-call';
            toolCallId: string;
            toolName: string;
            args: Record<string, unknown>;
          }
      >;
}

export interface ToolMessage {
  role: 'tool';
  content: Array<{ type: 'tool-result'; toolCallId: string; result: unknown }>;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;

export const createUserMessage = (
  content: string,
  _options?: MessageFactoryOptions
): UserMessage => ({
  role: 'user',
  content,
});

export const createAssistantMessage = (
  content: string,
  options?: MessageFactoryOptions & {
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }>;
  }
): AssistantMessage => {
  if (options?.toolCalls && options.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: [
        { type: 'text', text: content },
        ...options.toolCalls.map((tc) => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
      ],
    };
  }

  return {
    role: 'assistant',
    content,
  };
};

export const createToolResultMessage = (
  toolCallId: string,
  result: unknown,
  _options?: MessageFactoryOptions
): ToolMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId,
      result,
    },
  ],
});

export const createSystemMessage = (content: string): SystemMessage => ({
  role: 'system',
  content,
});

export const createConversation = (
  exchanges: Array<{ user: string; assistant: string }>
): Message[] => {
  const messages: Message[] = [];

  for (const exchange of exchanges) {
    messages.push(createUserMessage(exchange.user));
    messages.push(createAssistantMessage(exchange.assistant));
  }

  return messages;
};

export const createToolCallConversation = (
  userMessage: string,
  toolCalls: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
  }>,
  finalResponse: string
): Message[] => {
  const messages: Message[] = [createUserMessage(userMessage)];

  const toolCallsFormatted = toolCalls.map((tc) => ({
    toolCallId: nanoid(),
    toolName: tc.toolName,
    args: tc.args,
  }));

  messages.push(
    createAssistantMessage('', {
      toolCalls: toolCallsFormatted,
    })
  );

  for (let i = 0; i < toolCalls.length; i++) {
    messages.push(
      createToolResultMessage(toolCallsFormatted[i].toolCallId, toolCalls[i].result)
    );
  }

  messages.push(createAssistantMessage(finalResponse));

  return messages;
};

export const messageTemplates = {
  greeting: () => createUserMessage('Hello!'),
  codeQuestion: (language: string) =>
    createUserMessage(`How do I write a function in ${language}?`),
  fileRead: (path: string) => createUserMessage(`Read the file at ${path}`),
  fileWrite: (path: string, content: string) =>
    createUserMessage(`Write "${content}" to ${path}`),
  runCommand: (command: string) => createUserMessage(`Run the command: ${command}`),
  explain: (topic: string) => createUserMessage(`Explain ${topic}`),
  refactor: (description: string) => createUserMessage(`Refactor: ${description}`),
  debug: (error: string) => createUserMessage(`Debug this error: ${error}`),
};

export const responseTemplates = {
  acknowledgment: () => createAssistantMessage("I'll help you with that."),
  codeResponse: (code: string, language: string) =>
    createAssistantMessage(`Here's the code:\n\`\`\`${language}\n${code}\n\`\`\``),
  fileReadResponse: (content: string) =>
    createAssistantMessage(`Here's the file content:\n${content}`),
  errorResponse: (error: string) =>
    createAssistantMessage(`I encountered an error: ${error}`),
  completionResponse: () => createAssistantMessage('Task completed successfully.'),
};
