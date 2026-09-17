/** 内置验证 Subagent 配置 独立验证 Agent，用于在实现完成后进行质量评估。 严格只读 — 不能修改代码，只能运行构建、测试、lint 和对抗性检查。 */

import type { JsonObject } from '../../store/types.js';
import type { SubagentConfig } from './types.js';

export const INDEPENDENT_VERIFICATION_OUTPUT_SCHEMA: JsonObject = {
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

export function independentVerificationVerdictFromOutput(
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

import VERIFICATION_SYSTEM_PROMPT from './verification.md?raw';

/**
 * 验证 Agent 配置
 *
 * 独立验证 Agent，在实现完成后运行构建、测试、lint 和对抗性分析。
 * 严格只读 — 明确排除 Edit/Write/ApplyPatch/NotebookEdit/Task 等写入工具。
 */
export const verificationAgentConfig: SubagentConfig = {
  name: 'verification',
  description:
    'Independent verification agent that validates implementation' +
    ' by running builds, tests, linters, and adversarial' +
    ' probes. Strictly read-only — cannot modify code. Use' +
    ' after completing implementation to get an independent' +
    ' quality assessment.',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  maxTurns: 24,
  systemPrompt: VERIFICATION_SYSTEM_PROMPT,
  source: 'builtin',
};
