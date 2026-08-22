export function isolateManagedGitAttributionEnvironment(
  environment: NodeJS.ProcessEnv
): void;

export function createTestProcessEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  temporaryRoot: string
): NodeJS.ProcessEnv;

export function removeOwnedTestTemporaryRoot(
  temporaryRoot: string,
  options?: {
    maxWaitMs?: number;
    pollIntervalMs?: number;
    quietPeriodMs?: number;
  }
): Promise<void>;

export function reportTestTemporaryRootCleanupFailure(
  runError: unknown,
  cleanupError: unknown,
  report?: (message: string, error: unknown) => void
): void;
