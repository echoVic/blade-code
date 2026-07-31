const PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
> = {
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-v3': { input: 0.27, output: 1.1 },
  'deepseek-v4': { input: 0.27, output: 1.1 },
  'deepseek-v4-pro': { input: 0.27, output: 1.1 },
  'deepseek-v4-0724': { input: 0.27, output: 1.1 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  o1: { input: 15.0, output: 60.0 },
  'o1-mini': { input: 3.0, output: 12.0 },
  'o1-pro': { input: 150.0, output: 600.0 },
  o3: { input: 10.0, output: 40.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-3.5-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3.5-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-4-opus': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'qwen-plus': { input: 0.8, output: 2.0 },
  'qwen-max': { input: 2.0, output: 6.0 },
  'qwen-turbo': { input: 0.3, output: 0.6 },
  'qwen3-235b': { input: 2.0, output: 8.0 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
};

function findPricing(
  model: string
):
  | { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | undefined {
  const lower = model.toLowerCase();
  if (PRICING[lower]) return PRICING[lower];
  for (const [key, val] of Object.entries(PRICING)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return undefined;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number
): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;

  let cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  if (cacheReadTokens && pricing.cacheRead) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheRead;
  }
  if (cacheWriteTokens && pricing.cacheWrite) {
    cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  }

  return Math.round(cost * 1_000_000) / 1_000_000;
}
