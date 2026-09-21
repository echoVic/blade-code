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
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../api/attachmentLimits.js';
import { withSelectedConversationContext } from '../../context/selectedConversationContext.js';
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
  consumeBytes: (bytes: number) => void,
  signal: AbortSignal,
  source: 'user' | 'tool'
): Promise<ImageContent | TextContent> {
  signal.throwIfAborted();
  const inline = parseDataUrl(url);
  if (inline) {
    // Tool-owned inline screenshots are bounded by their artifact store.
    if (source === 'user') consumeBytes(Buffer.byteLength(url));
    return { type: 'image', ...inline };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { type: 'text', text: '[Unsupported image source]' };
  }

  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error('Image download timed out')),
    30_000
  );
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader?.cancel(downloadSignal.reason).catch(() => undefined);
  };
  try {
    response = await fetch(url, { signal: downloadSignal });
    if (!response.ok) {
      throw new Error(`Failed to load image: HTTP ${response.status}`);
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png';
    consumeBytes(Buffer.byteLength(`data:${mimeType};base64,`));
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let encodedBytes = 0;
    reader = response.body?.getReader();
    downloadSignal.addEventListener('abort', cancel, { once: true });
    downloadSignal.throwIfAborted();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        downloadSignal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        const nextEncodedBytes = 4 * Math.ceil(bytes / 3);
        consumeBytes(nextEncodedBytes - encodedBytes);
        encodedBytes = nextEncodedBytes;
        chunks.push(chunk.value);
      }
    }
    return {
      type: 'image',
      mimeType,
      data: Buffer.concat(chunks, bytes).toString('base64'),
    };
  } catch (error) {
    if (downloadSignal.aborted) throw downloadSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    downloadSignal.removeEventListener('abort', cancel);
    if (reader) {
      cancel();
      await cancellation;
      reader.releaseLock();
    } else {
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}

async function multimodalContent(
  content: ContentPart[],
  supportsImages: boolean,
  signal: AbortSignal | undefined,
  source: 'user' | 'tool'
): Promise<Array<TextContent | ImageContent>> {
  const controller = new AbortController();
  const batchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let usedBytes = 0;
  const consumeBytes = (bytes: number) => {
    usedBytes += bytes;
    if (usedBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error('Image attachments exceed the 5 MiB limit');
    }
  };
  const pending = content.map((part) =>
    part.type === 'text'
      ? Promise.resolve<TextContent>({ type: 'text', text: part.text })
      : supportsImages
        ? imageContent(part.image_url.url, consumeBytes, batchSignal, source)
        : Promise.resolve<TextContent>({
            type: 'text',
            text: '[Image omitted: current model does not support image input]',
          })
  );
  try {
    return await Promise.all(pending);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(pending);
    throw error;
  }
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
  const supportsImages = model.input.includes('image');

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const visibleContent = withSelectedConversationContext(
        message.content,
        message.metadata
      );
      const content =
        typeof visibleContent === 'string'
          ? visibleContent
          : await multimodalContent(visibleContent, supportsImages, signal, 'user');
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
      content:
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : await multimodalContent(message.content, supportsImages, signal, 'tool'),
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
    }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: contextMessages,
    ...(piTools?.length ? { tools: piTools } : {}),
  };
}
