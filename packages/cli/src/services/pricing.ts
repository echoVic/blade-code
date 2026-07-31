const PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  'deepseek-chat': { input: 0.27, output: 1.10 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-v3': { input: 0.27, output: 1.10 },
  'deepseek-v4': { input: 0.27, output: 1.10 },
  'deepseek-v4-pro': { input: 0.27, output: 1.10 },
  'deepseek-v4-0724': { input: 0.27, output: 1.10 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 3.00, output: 12.00 },
  'o1-pro': { input: 150.00, output: 600.00 },
  'o3': { input: 10.00, output: 40.00 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o4-mini': { input: 1.10, output: 4.40 },
  'claude-3.5-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3.5-haiku': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-sonnet-4': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-4-opus': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'qwen-plus': { input: 0.80, output: 2.00 },
  'qwen-max': { input: 2.00, output: 6.00 },
  'qwen-turbo': { input: 0.30, output: 0.60 },
  'qwen3-235b': { input: 2.00, output: 8.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
};

function findPricing(model: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined {
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

  let cost = (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  if (cacheReadTokens && pricing.cacheRead) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheRead;
  }
  if (cacheWriteTokens && pricing.cacheWrite) {
    cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  }

  return Math.round(cost * 1_000_000) / 1_000_000;
}
