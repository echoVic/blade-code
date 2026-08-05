export interface TestTypeConfig {
  name: string;
  project: string | null;
  timeout: number;
  env?: NodeJS.ProcessEnv;
  files?: string[];
  coverageExcludedProjects?: string[];
}

export const testTypes: Record<string, TestTypeConfig> & {
  realApi: TestTypeConfig;
};
