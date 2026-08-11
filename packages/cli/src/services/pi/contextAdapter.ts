import type {
  Api,
  Context,
  ImageContent,
  Model,
  Tool as PiTool,
  TextContent,
  ThinkingContent,
  ToolCall,
  TSchema,
} from '@earendil-works/pi-ai';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type {
  ChatToolDefinition,
  ContentPart,
  Message,
} from '../ChatServiceInterface.js';

const logger = createLogger(LogCategory.CHAT);
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function textContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function parseArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    logger.warn('[PiAIChatService] Invalid historical tool arguments', { value });
    return {};
  }
}

function parseDataUrl(url: string): Omit<ImageContent, 'type'> | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : undefined;
}

async function imageContent(
  url: string,
  signal?: AbortSignal
): Promise<ImageContent | TextContent> {
  const inline = parseDataUrl(url);
  if (inline) return { type: 'image', ...inline };
  if (!/^https?:\/\//i.test(url)) {
    return { type: 'text', text: `[Unsupported image source: ${url}]` };
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load image ${url}: HTTP ${response.status}`);
  }
  return {
    type: 'image',
    mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png',
    data: Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
}

export async function createPiContext(
  messages: Message[],
  model: Model<Api>,
  tools?: ChatToolDefinition[],
  signal?: AbortSignal,
  requiredToolName?: string
): Promise<Context> {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => textContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const contextMessages: Context['messages'] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const supportsImages = model.input.includes('image');
      const content =
        typeof message.content === 'string'
          ? message.content
          : await Promise.all(
              message.content.map((part) =>
                part.type === 'text'
                  ? Promise.resolve<TextContent>({
                      type: 'text',
                      text: part.text,
                    })
                  : supportsImages
                    ? imageContent(part.image_url.url, signal)
                    : Promise.resolve<TextContent>({
                        type: 'text',
                        text: '[Image omitted: current model does not support image input]',
                      })
              )
            );
      contextMessages.push({ role: 'user', content, timestamp: Date.now() });
      continue;
    }

    if (message.role === 'assistant') {
      const content: Array<TextContent | ThinkingContent | ToolCall> = [];
      if (message.reasoningContent?.trim()) {
        content.push({ type: 'thinking', thinking: message.reasoningContent });
      }
      const text = textContent(message.content);
      if (text) content.push({ type: 'text', text });
      for (const call of message.tool_calls ?? []) {
        if (!('function' in call)) continue;
        content.push({
          type: 'toolCall',
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
        });
      }
      contextMessages.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: message.tool_calls?.length ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      });
      continue;
    }

    contextMessages.push({
      role: 'toolResult',
      toolCallId: message.tool_call_id ?? '',
      toolName: message.name ?? 'unknown',
      content: [{ type: 'text', text: textContent(message.content) }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  const piTools: PiTool[] | undefined = tools
    ?.filter((tool) => !requiredToolName || tool.name === requiredToolName)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as TSchema,
      constrainedSampling: tool.constrainedSampling,
    }));
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: contextMessages,
    ...(piTools?.length ? { tools: piTools } : {}),
  };
}
