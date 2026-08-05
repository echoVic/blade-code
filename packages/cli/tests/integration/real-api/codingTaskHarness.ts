import {
  type HeadlessJsonlEvent,
  HeadlessJsonlEventSchema,
} from '../../../src/commands/headlessEvents.js';

export interface RealApiModelConfigInput {
  modelId: string;
  model: string;
  baseUrl: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface ParsedHeadlessJsonl {
  events: HeadlessJsonlEvent[];
  nonJsonLines: string[];
}

export function parseHeadlessJsonl(stdout: string): ParsedHeadlessJsonl {
  const events: HeadlessJsonlEvent[] = [];
  const nonJsonLines: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const result = HeadlessJsonlEventSchema.safeParse(parsed);
      if (result.success) {
        events.push(result.data);
      } else {
        nonJsonLines.push(line);
      }
    } catch {
      nonJsonLines.push(line);
    }
  }

  return { events, nonJsonLines };
}

export function buildRealApiConfig(
  input: RealApiModelConfigInput
): Record<string, unknown> {
  return {
    currentModelId: input.modelId,
    ...(input.maxContextTokens !== undefined
      ? { maxContextTokens: input.maxContextTokens }
      : {}),
    models: [
      {
        id: input.modelId,
        displayName: input.model,
        provider: 'deepseek',
        model: input.model,
        overrides: {
          baseUrl: input.baseUrl,
          maxOutputTokens: input.maxOutputTokens ?? 4_096,
          timeout: 180_000,
        },
      },
    ],
  };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join('[REDACTED]'), text);
}
