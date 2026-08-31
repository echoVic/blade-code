export interface TestTypeConfig {
  name: string;
  project: string | null;
  timeout: number;
  coverageTimeout?: number;
  env?: NodeJS.ProcessEnv;
  files?: string[];
  coverageExcludedProjects?: string[];
}

export const testTypes: Record<string, TestTypeConfig> & {
  realApi: TestTypeConfig;
  realApiQualification: TestTypeConfig;
};

export function resolveTestTimeout(
  config: Pick<TestTypeConfig, 'timeout' | 'coverageTimeout'>,
  options: { coverage?: boolean }
): number;
