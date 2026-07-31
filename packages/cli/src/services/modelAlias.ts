/**
 * Model Alias Resolution
 *
 * Maps short/convenient names to full model IDs.
 * Used by config loading, /model command, and BLADE_MODEL env var.
 */

const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
  haiku: 'claude-3-5-haiku-20241022',
  claude: 'claude-sonnet-4-20250514',

  // OpenAI
  gpt4o: 'gpt-4o',
  gpt4: 'gpt-4o',
  o1: 'o1',
  o3: 'o3',
  'o4-mini': 'o4-mini',

  // DeepSeek
  deepseek: 'deepseek-chat',
  'deepseek-v3': 'deepseek-chat',
  'deepseek-r1': 'deepseek-reasoner',
  'deepseek-v4': 'deepseek-v4-0324',

  // Google
  gemini: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',

  // Qwen
  qwen: 'qwen3-235b-a22b',
  'qwen-max': 'qwen-max',
  'qwen-plus': 'qwen-plus',
};

/**
 * Resolve a model alias to its full ID.
 * If no alias matches, returns the input unchanged (assumed to be a full ID).
 */
export function resolveModelAlias(nameOrAlias: string): string {
  const lower = nameOrAlias.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? nameOrAlias;
}

/**
 * Check if a string is a known alias.
 */
export function isModelAlias(name: string): boolean {
  return name.toLowerCase().trim() in MODEL_ALIASES;
}

/**
 * Get all available aliases for display.
 */
export function getModelAliases(): Array<{ alias: string; model: string }> {
  return Object.entries(MODEL_ALIASES).map(([alias, model]) => ({ alias, model }));
}
