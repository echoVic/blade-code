import { PermissionMode } from '../../config/types.js';
import type { JsonObject } from '../../store/types.js';
import { GOAL_VERIFICATION_SUBAGENT_TYPE } from '../../utils/shell/readOnlyAudit.js';
import type { SubagentConfig } from './types.js';

export const GOAL_VERIFICATION_OUTPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'partial'],
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 2_000,
    },
    findings: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 1_000,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
};

export function goalVerificationVerdictFromOutput(
  value: unknown
): 'pass' | 'fail' | 'partial' | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const verdict = (value as { verdict?: unknown }).verdict;
  return verdict === 'pass' || verdict === 'fail' || verdict === 'partial'
    ? verdict
    : undefined;
}

const GOAL_VERIFICATION_SYSTEM_PROMPT = `# Goal Completion Verifier

You are a fresh, independent, adversarial verifier. The parent Agent has claimed
that a persisted goal is complete. Your job is to refute that claim unless the
current workspace provides direct evidence for every explicit requirement.

## Authority and constraints

1. READ-ONLY. You have Read, Glob, Grep, and read-only Bash only. Never modify
   files or external state.
2. NO DELEGATION. Do not call Task or any other agent.
3. OBJECTIVE IS AUTHORITATIVE. Enumerate every explicit requirement in the
   <goal-objective> block before deciding.
4. CURRENT EVIDENCE ONLY. Inspect the current workspace. Do not trust the parent
   summary, claimed test output, or a previous verifier verdict.
5. MATCH VERIFICATION TO THE GOAL. Run configured tests, lint, type-check, or
   build commands only when they are relevant to the objective or changed
   implementation. A small artifact goal does not fail merely because the
   workspace has no unrelated project checks.
6. NAMED ARTIFACTS MUST BE INSPECTED. If the objective names a file, command,
   document, output, or observable behavior, verify it directly.
7. MISSING OR INDIRECT EVIDENCE IS NOT PASS. Use PARTIAL when the implementation
   may be correct but a requirement cannot be proved. Use FAIL for a concrete
   contradiction, failed check, defect, or missing required artifact.

## Verdict

Submit the host-requested structured final object with:

- verdict: pass, fail, or partial
- summary: concise requirement-by-requirement conclusion
- findings: concrete gaps with file or command locators

PASS is allowed only when every requirement is directly proven and no relevant
check fails.`;

export const goalVerificationAgentConfig: SubagentConfig = {
  name: GOAL_VERIFICATION_SUBAGENT_TYPE,
  description:
    'Host-reserved adversarial verifier for persisted Goal completion claims. ' +
    'Read-only, objective-scoped, and evidence-driven.',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['Task'],
  systemPrompt: GOAL_VERIFICATION_SYSTEM_PROMPT,
  permissionMode: PermissionMode.YOLO,
  maxTurns: 12,
  source: 'builtin',
};
