#!/usr/bin/env bun

import {
  createQualificationPlan,
  resolveQualificationRoot,
  resolveProductionEnvironment,
  runQualification,
  type QualificationMode,
} from './qualification.js';

const mode = process.argv[2];

if (mode !== 'local' && mode !== 'production') {
  console.error('Usage: bun run scripts/qualify.ts [local|production]');
  process.exit(2);
}

const qualificationMode = mode as QualificationMode;
const repositoryRoot = resolveQualificationRoot(import.meta.dir);

let environment: Record<string, string | undefined> = {
  ...process.env,
};
if (qualificationMode === 'production') {
  try {
    environment = {
      ...environment,
      ...resolveProductionEnvironment(environment),
    };
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    );
    process.exit(2);
  }
}

const checks = createQualificationPlan(qualificationMode);
const result = await runQualification(checks, {
  cwd: repositoryRoot,
  env: environment,
  execute: async (check, context) => {
    const child = Bun.spawn([check.command, ...check.args], {
      cwd: context.cwd,
      env: context.env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  },
  onCheckStart: (check) => {
    console.log(`\n[qualification] ${check.name}`);
  },
  onCheckComplete: (_check, exitCode) => {
    console.log(`[qualification] exit=${exitCode}`);
  },
});

if (!result.passed) {
  console.error(
    `[qualification] failed at ${result.failedCheck} (exit ${result.exitCode})`
  );
  process.exit(result.exitCode || 1);
}

console.log(
  `[qualification] passed ${result.completedChecks}/${checks.length} checks`
);
