import type { CommunicationStyleSummary } from '@api/schemas';

/**
 * Built-in communication styles surfaced when the model/agent catalog has not
 * supplied its own list. Kept in one place so the composer default and the
 * Settings selector agree on the same baseline set.
 */
export const DEFAULT_COMMUNICATION_STYLES: CommunicationStyleSummary[] = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'Use the Blade default communication style',
    source: 'built-in',
  },
  {
    id: 'pragmatic',
    name: 'Pragmatic',
    description: 'Direct, factual, concise, and action-oriented',
    source: 'built-in',
  },
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'Warm, collaborative, and task-focused',
    source: 'built-in',
  },
  {
    id: 'explanatory',
    name: 'Explanatory',
    description: 'Explain codebase-specific choices and tradeoffs',
    source: 'built-in',
  },
];
