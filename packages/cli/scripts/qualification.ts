import { resolve } from 'node:path';

export type QualificationMode = 'local' | 'production';

export interface QualificationCheck {
  id: string;
  name: string;
  command: string;
  args: string[];
  network?: 'paid-api';
}

export interface QualificationRunOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  execute: (
    check: QualificationCheck,
    context: {
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
    }
  ) => Promise<number>;
  onCheckStart?: (check: QualificationCheck) => void;
  onCheckComplete?: (check: QualificationCheck, exitCode: number) => void;
}

export interface QualificationResult {
  passed: boolean;
  completedChecks: number;
  failedCheck?: string;
  exitCode?: number;
}

export interface ProductionEnvironmentOptions {
  hasConfiguredDeepSeekApiKey?: boolean;
}

const REQUIRED_DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const;

const LOCAL_CHECKS: readonly QualificationCheck[] = [
  { id: 'type-check', name: 'Type check', command: 'bun', args: ['run', 'type-check'] },
  {
    id: 'format-check',
    name: 'Format check',
    command: 'bun',
    args: ['run', 'format:check'],
  },
  { id: 'lint', name: 'Lint', command: 'bun', args: ['run', 'lint'] },
  { id: 'unit', name: 'Unit tests', command: 'bun', args: ['run', 'test:unit'] },
  {
    id: 'integration',
    name: 'Integration tests',
    command: 'bun',
    args: ['run', 'test:integration'],
  },
  { id: 'cli', name: 'CLI tests', command: 'bun', args: ['run', 'test:cli'] },
  {
    id: 'headless-core',
    name: 'Headless runtime tests',
    command: 'bun',
    args: ['run', 'test:headless-core'],
  },
  { id: 'e2e', name: 'End-to-end tests', command: 'bun', args: ['run', '--filter', 'blade-code', 'test:e2e'] },
  {
    id: 'snapshot',
    name: 'Snapshot tests',
    command: 'bun',
    args: ['run', '--filter', 'blade-code', 'test:snapshot'],
  },
  {
    id: 'security',
    name: 'Security tests',
    command: 'bun',
    args: ['run', '--filter', 'blade-code', 'test:security'],
  },
  { id: 'web-test', name: 'Web tests', command: 'bun', args: ['run', 'test:web'] },
  {
    id: 'web-type-check',
    name: 'Web type check',
    command: 'bun',
    args: ['run', 'type-check:web'],
  },
  { id: 'build', name: 'Production build', command: 'bun', args: ['run', 'build'] },
  {
    id: 'performance',
    name: 'Performance regression tests',
    command: 'bun',
    args: ['run', '--filter', 'blade-code', 'test:performance'],
  },
];

export function resolveQualificationRoot(scriptsDirectory: string): string {
  return resolve(scriptsDirectory, '../../..');
}

export function createQualificationPlan(
  mode: QualificationMode
): QualificationCheck[] {
  const plan = LOCAL_CHECKS.map((check) => ({ ...check, args: [...check.args] }));
  if (mode === 'production') {
    plan.push({
      id: 'real-api',
      name: 'Real API coding trajectories',
      command: 'bun',
      args: ['run', 'test:real-api'],
      network: 'paid-api',
    });
  }
  return plan;
}

export function resolveProductionEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  options: ProductionEnvironmentOptions = {}
): Record<string, string> {
  const apiKey = input.DEEPSEEK_API_KEY?.trim();
  if (!apiKey && !options.hasConfiguredDeepSeekApiKey) {
    throw new Error(
      'DeepSeek credentials are required for production qualification; set ' +
        'DEEPSEEK_API_KEY or configure DeepSeek in ~/.blade/config.json.'
    );
  }

  if (!apiKey) {
    return {
      REAL_API_TEST: '1',
    };
  }

  const configuredModels = (
    input.DEEPSEEK_MODELS ?? REQUIRED_DEEPSEEK_MODELS.join(',')
  )
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const missingModels = REQUIRED_DEEPSEEK_MODELS.filter(
    (model) => !configuredModels.includes(model)
  );
  if (missingModels.length > 0) {
    throw new Error(
      `DEEPSEEK_MODELS must include: ${missingModels.join(', ')}`
    );
  }

  return {
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL:
      input.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    DEEPSEEK_MODELS: configuredModels.join(','),
    DEEPSEEK_MODEL: configuredModels[0],
    REAL_API_TEST: '1',
  };
}

export async function runQualification(
  checks: readonly QualificationCheck[],
  options: QualificationRunOptions
): Promise<QualificationResult> {
  let completedChecks = 0;

  for (const check of checks) {
    options.onCheckStart?.(check);
    const exitCode = await options.execute(check, {
      cwd: options.cwd,
      env: options.env,
    });
    options.onCheckComplete?.(check, exitCode);
    if (exitCode !== 0) {
      return {
        passed: false,
        completedChecks,
        failedCheck: check.id,
        exitCode,
      };
    }
    completedChecks += 1;
  }

  return { passed: true, completedChecks };
}
