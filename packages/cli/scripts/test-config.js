export const testTypes = {
  unit: {
    name: '单元测试',
    project: 'unit',
    timeout: 480_000,
  },
  integration: {
    name: '集成测试',
    project: 'integration',
    timeout: 600_000,
    requiresProductionBuild: true,
  },
  realApi: {
    name: '真实 API 集成测试',
    project: 'real-api',
    timeout: 60 * 60 * 1_000,
    requiresProductionBuild: true,
    env: {
      REAL_API_TEST: '1',
    },
  },
  realApiQualification: {
    name: '发布阻断真实 API 集成测试',
    project: 'real-api',
    timeout: 90 * 60 * 1_000,
    requiresProductionBuild: true,
    files: [
      'tests/integration/real-api/agent-trajectory.test.ts',
      'tests/integration/real-api/structured-output-trajectory.test.ts',
      'tests/integration/real-api/code-review-trajectory.test.tsx',
      'tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts',
      'tests/integration/real-api/acp-session-fork-trajectory.test.ts',
      'tests/integration/real-api/release-coding-trajectory.test.ts',
      'tests/integration/real-api/task-list-team-trajectory.test.ts',
      'tests/integration/real-api/provider-retry-trajectory.test.ts',
      'tests/integration/real-api/cross-provider-fallback-trajectory.test.ts',
      'tests/integration/real-api/provider-attempt-deadline-web-trajectory.test.ts',
      'tests/integration/real-api/prompt-cache-surface-trajectory.test.ts',
      'tests/integration/real-api/action-stationarity-trajectory.test.ts',
      'tests/integration/real-api/goal-mode-trajectory.test.ts',
      'tests/integration/real-api/root-turn-auto-resume-trajectory.test.ts',
      'tests/integration/real-api/goal-finalization-handoff-trajectory.test.ts',
      'tests/integration/real-api/subagent-result-adoption-trajectory.test.ts',
      'tests/integration/real-api/background-subagent-completion-trajectory.test.ts',
      'tests/integration/real-api/durable-task-unread-trajectory.test.ts',
      'tests/integration/real-api/tui-task-attention-trajectory.test.ts',
      'tests/integration/real-api/foreground-bounded-output-trajectory.test.ts',
      'tests/integration/real-api/foreground-command-handoff-trajectory.test.ts',
      'tests/integration/real-api/token-budget-handoff-trajectory.test.ts',
      'tests/integration/real-api/browser-preview-trajectory.test.ts',
      'tests/integration/real-api/browser-tool-trajectory.test.ts',
      'tests/integration/real-api/large-prompt-offload-trajectory.test.ts',
      'tests/integration/real-api/compaction-rich-media-trajectory.test.ts',
      'tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts',
      'tests/integration/real-api/provider-rate-limit-cooldown-trajectory.test.ts',
      'tests/integration/real-api/turn-activity-surface-trajectory.test.ts',
      'tests/integration/real-api/provider-request-admission-acp-trajectory.test.ts',
      'tests/integration/real-api/provider-request-admission-web-trajectory.test.ts',
      'tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts',
      'tests/integration/real-api/weighted-provider-admission-acp-trajectory.test.ts',
      'tests/integration/real-api/weighted-provider-admission-web-trajectory.test.ts',
      'tests/integration/real-api/weighted-task-admission-acp-trajectory.test.ts',
      'tests/integration/real-api/weighted-task-admission-web-trajectory.test.ts',
      'tests/integration/real-api/keyed-coordination-reclamation-trajectory.test.ts',
      'tests/integration/real-api/session-runtime-residency-acp-trajectory.test.ts',
      'tests/integration/real-api/session-runtime-residency-controls-trajectory.test.ts',
      'tests/integration/real-api/session-runtime-residency-web-trajectory.test.ts',
      'tests/integration/real-api/graceful-shutdown-trajectory.test.ts',
      'tests/integration/real-api/tool-admission-trajectory.test.ts',
      'tests/integration/real-api/side-conversation-trajectory.test.ts',
      'tests/integration/real-api/follow-up-queue-trajectory.test.ts',
    ],
    env: {
      REAL_API_TEST: '1',
      REAL_API_RELEASE_MATRIX: '1',
    },
  },
  cli: {
    name: 'CLI 测试',
    project: 'cli',
    timeout: 60_000,
    requiresProductionBuild: true,
  },
  headlessCore: {
    name: 'Headless 核心回归测试',
    project: null,
    timeout: 120_000,
    requiresProductionBuild: true,
    files: [
      'tests/unit/cli/headless.test.ts',
      'tests/unit/cli/headless-events.test.ts',
      'tests/integration/cli/blade-help.test.ts',
      'tests/unit/agent-runtime/context/jsonl-recovery.test.ts',
      'tests/unit/agent-runtime/agent/session-lease.test.ts',
      'tests/unit/agent-runtime/agent/session-runtime.test.ts',
      'tests/unit/agent-runtime/agent/subagent-registry.test.ts',
      'tests/unit/agent-runtime/server/session-routes.test.ts',
      'tests/unit/agent-runtime/acp/session.test.ts',
    ],
  },
  e2e: {
    name: 'E2E 测试',
    project: 'e2e',
    timeout: 180_000,
    requiresProductionBuild: true,
  },
  performance: {
    name: '性能测试',
    project: 'performance',
    timeout: 300_000,
    requiresProductionBuild: true,
  },
  snapshot: {
    name: '快照测试',
    project: 'snapshot',
    timeout: 45_000,
  },
  security: {
    name: '安全测试',
    project: 'security',
    timeout: 90_000,
  },
  all: {
    name: '所有测试',
    project: null,
    timeout: 600_000,
    requiresProductionBuild: true,
    coverageTimeout: 900_000,
    coverageExcludedProjects: ['performance'],
    projectSequence: ['!performance', 'performance'],
  },
};

export function resolveTestTimeout(config, options) {
  return options.coverage
    ? (config.coverageTimeout ?? config.timeout)
    : config.timeout;
}

export function createTestExecutionStages(config, options = {}) {
  const projects =
    options.coverage && config.coverageExcludedProjects
      ? config.coverageExcludedProjects.map(project => `!${project}`)
      : (config.projectSequence ?? [config.project]);
  return [
    ...(config.requiresProductionBuild ? [{ kind: 'production-build' }] : []),
    ...projects.map(project => ({
      kind: 'vitest',
      project,
    })),
  ];
}
