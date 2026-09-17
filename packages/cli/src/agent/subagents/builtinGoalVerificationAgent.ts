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

import GOAL_VERIFICATION_SYSTEM_PROMPT from './goal-verification.md?raw';

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
