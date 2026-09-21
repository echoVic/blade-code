import { statSync } from 'node:fs';
import path from 'node:path';

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
    files: [
      'tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts',
      'tests/integration/real-api/agent-trajectory.test.ts',
      'tests/integration/real-api/browser-tool-trajectory.test.ts',
      'tests/integration/real-api/cross-provider-fallback-trajectory.test.ts',
      'tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts',
      'tests/integration/real-api/find-files-trajectory.test.ts',
      'tests/integration/real-api/goal-mode-trajectory.test.ts',
      'tests/integration/real-api/goal-paused-usage-trajectory.test.ts',
      'tests/integration/real-api/release-coding-trajectory.test.ts',
      'tests/integration/real-api/structured-output-trajectory.test.ts',
      'tests/integration/real-api/task-list-team-trajectory.test.ts',
      'tests/integration/real-api/workspace-agent-resources-trajectory.test.ts',
    ],
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
      'tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts',
      'tests/integration/real-api/find-files-trajectory.test.ts',
      'tests/integration/real-api/release-coding-trajectory.test.ts',
      'tests/integration/real-api/task-list-team-trajectory.test.ts',
      'tests/integration/real-api/cross-provider-fallback-trajectory.test.ts',
      'tests/integration/real-api/goal-mode-trajectory.test.ts',
      'tests/integration/real-api/browser-tool-trajectory.test.ts',
      'tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts',
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
      'tests/unit/cli/headless-boundaries.test.ts',
      'tests/unit/cli/headless-event-contract.test.ts',
      'tests/integration/cli/blade-help.test.ts',
      'tests/unit/agent-runtime/context/jsonl-recovery.test.ts',
      'tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts',
      'tests/unit/agent-runtime/agent/session-lease.test.ts',
      'tests/unit/agent-runtime/agent/completion-policy.test.ts',
      'tests/unit/agent-runtime/agent/subagent-registry.test.ts',
      'tests/unit/agent-runtime/server/task-routes.test.ts',
      'tests/unit/agent-runtime/acp/bladeAgent.test.ts',
      'tests/unit/services/session-interaction-recovery.test.ts',
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
    coverageTimeout: 1_200_000,
    coverageExcludedProjects: ['performance'],
    projectSequence: ['!performance', 'performance'],
  },
};

export function assertConfiguredTestFilesExist(config, rootDirectory) {
  for (const file of config.files ?? []) {
    let exists = false;
    try {
      exists = statSync(path.resolve(rootDirectory, file)).isFile();
    } catch {
      // Report one stable configuration error below.
    }
    if (!exists) {
      throw new Error(`${config.name} contains missing test file: ${file}`);
    }
  }
}

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
