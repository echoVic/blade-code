import { PermissionMode } from '../../config/types.js';
import { MAX_GOAL_VERIFICATION_FEEDBACK_CHARS } from '../../goals/types.js';
import type { JsonObject } from '../../store/types.js';
import { GOAL_VERIFICATION_SUBAGENT_TYPE } from '../../utils/shell/readOnlyAudit.js';
import type { SubagentConfig } from './types.js';

const MAX_GOAL_VERIFICATION_SUMMARY_CHARS = 2_000;
const MAX_GOAL_VERIFICATION_FINDINGS = 50;
const MAX_GOAL_VERIFICATION_FINDING_CHARS = 1_000;

export interface GoalVerificationOutput {
  verdict: 'pass' | 'fail' | 'partial';
  summary: string;
  findings: string[];
}

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
      maxLength: MAX_GOAL_VERIFICATION_SUMMARY_CHARS,
    },
    findings: {
      type: 'array',
      maxItems: MAX_GOAL_VERIFICATION_FINDINGS,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_GOAL_VERIFICATION_FINDING_CHARS,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
};

function sanitizeFeedbackText(value: string, workspaceRoot?: string): string {
  let sanitized = value.trim().replaceAll(/\s+/g, ' ');
  if (workspaceRoot) sanitized = sanitized.replaceAll(workspaceRoot, '.');
  return sanitized
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(
      /\b(api(?:[_-]?|\s+)key|access(?:[_-]?|\s+)token|authorization|cookie|password|passwd|refresh(?:[_-]?|\s+)token|secret|session(?:[_-]?|\s+)token)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[redacted]'
    );
}

function truncateFeedback(value: string): string {
  if (value.length <= MAX_GOAL_VERIFICATION_FEEDBACK_CHARS) return value;
  const suffix = ' [verification feedback truncated]';
  let prefix = value.slice(0, MAX_GOAL_VERIFICATION_FEEDBACK_CHARS - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix.trimEnd() + suffix;
}

export function goalVerificationOutputFromValue(
  value: unknown
): GoalVerificationOutput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    verdict?: unknown;
    summary?: unknown;
    findings?: unknown;
  };
  if (
    (candidate.verdict !== 'pass' &&
      candidate.verdict !== 'fail' &&
      candidate.verdict !== 'partial') ||
    typeof candidate.summary !== 'string' ||
    !candidate.summary.trim() ||
    candidate.summary.length > MAX_GOAL_VERIFICATION_SUMMARY_CHARS ||
    !Array.isArray(candidate.findings) ||
    candidate.findings.length > MAX_GOAL_VERIFICATION_FINDINGS ||
    !candidate.findings.every(
      (finding) =>
        typeof finding === 'string' &&
        finding.trim().length > 0 &&
        finding.length <= MAX_GOAL_VERIFICATION_FINDING_CHARS
    )
  ) {
    return undefined;
  }
  return {
    verdict: candidate.verdict,
    summary: candidate.summary.trim(),
    findings: candidate.findings.map((finding) => finding.trim()),
  };
}

export function goalVerificationFeedbackFromOutput(
  value: unknown,
  workspaceRoot?: string
): string | undefined {
  const output = goalVerificationOutputFromValue(value);
  if (!output) return undefined;
  const summary = sanitizeFeedbackText(output.summary, workspaceRoot);
  const findings = output.findings.map((finding) =>
    sanitizeFeedbackText(finding, workspaceRoot)
  );
  return truncateFeedback(
    [
      summary,
      findings.length > 0
        ? `Findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  );
}

export function goalVerificationVerdictFromOutput(
  value: unknown
): 'pass' | 'fail' | 'partial' | undefined {
  return goalVerificationOutputFromValue(value)?.verdict;
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
8. SAFE FEEDBACK. Keep summary and findings concise, use workspace-relative
   file locations, and never include credentials or secret values.

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
