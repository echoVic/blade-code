import { PermissionMode } from '../../config/types.js';
import { REVIEW_SUBAGENT_TYPE } from '../../utils/shell/readOnlyAudit.js';
import REVIEW_SYSTEM_PROMPT from './review.md?raw';
import type { SubagentConfig } from './types.js';

export const reviewAgentConfig: SubagentConfig = {
  name: REVIEW_SUBAGENT_TYPE,
  description:
    'Independent read-only code reviewer for uncommitted changes, base branches, and commits.',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['Task', 'WebFetch', 'WebSearch'],
  permissionMode: PermissionMode.DEFAULT,
  maxTurns: 24,
  systemPrompt: REVIEW_SYSTEM_PROMPT,
  source: 'builtin',
};
