#!/usr/bin/env bun

import { FileCredentialStore } from '../src/services/pi/FileCredentialStore.js';
import {
  createQualificationPlan,
  resolveQualificationCheckEnvironment,
  resolveQualificationRoot,
  resolveProductionEnvironment,
  runQualification,
  type QualificationMode,
} from './qualification.js';
import { materializeRealApiEnvironment } from './real-api-credentials.js';

const mode = process.argv[2];

if (mode !== 'local' && mode !== 'production') {
  console.error('Usage: bun run scripts/qualify.ts [local|production]');
  process.exit(2);
}

const qualificationMode = mode as QualificationMode;
const repositoryRoot = resolveQualificationRoot(import.meta.dir);

const environment: Record<string, string | undefined> = {
  ...process.env,
};
let paidApiEnvironment = environment;
if (qualificationMode === 'production') {
  try {
    const credentialEnvironment = materializeRealApiEnvironment(environment);
    const deepSeekCredential = await new FileCredentialStore().read('deepseek');
    paidApiEnvironment = {
      ...credentialEnvironment,
      ...resolveProductionEnvironment(credentialEnvironment, {
        hasConfiguredDeepSeekApiKey:
          deepSeekCredential?.type === 'api_key' &&
          typeof deepSeekCredential.key === 'string' &&
          Boolean(deepSeekCredential.key.trim()),
      }),
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
    const checkEnvironment = resolveQualificationCheckEnvironment(
      check,
      context.env,
      paidApiEnvironment
    );
    const child = Bun.spawn([check.command, ...check.args], {
      cwd: context.cwd,
      env: checkEnvironment,
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
