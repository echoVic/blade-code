import { access, rm } from 'node:fs/promises';

const MANAGED_GIT_ATTRIBUTION_PREFIX = 'TRAE_GIT_ATTRIBUTION_';

function parseCanonicalNonNegativeInteger(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function isolateManagedGitAttributionEnvironment(environment) {
  if (environment.TRAE_GIT_ATTRIBUTION_MANAGED_HOOK !== '1') return;

  const count = parseCanonicalNonNegativeInteger(environment.GIT_CONFIG_COUNT);
  const slot = parseCanonicalNonNegativeInteger(
    environment.TRAE_GIT_ATTRIBUTION_CONFIG_SLOT
  );
  const isFinalSlot = count !== undefined && count > 0 && slot === count - 1;
  const isManagedHookSlot =
    slot !== undefined && environment[`GIT_CONFIG_KEY_${slot}`] === 'core.hooksPath';
  if (!isFinalSlot || !isManagedHookSlot) {
    throw new Error('Managed Git attribution environment is inconsistent');
  }

  delete environment[`GIT_CONFIG_KEY_${slot}`];
  delete environment[`GIT_CONFIG_VALUE_${slot}`];
  if (slot === 0) delete environment.GIT_CONFIG_COUNT;
  else environment.GIT_CONFIG_COUNT = String(slot);
  if (environment.TRAE_GIT_ATTRIBUTION_ORIGINAL_CONFIG_PARAMETERS_PRESENT === '1') {
    environment.GIT_CONFIG_PARAMETERS =
      environment.TRAE_GIT_ATTRIBUTION_ORIGINAL_CONFIG_PARAMETERS;
  } else {
    delete environment.GIT_CONFIG_PARAMETERS;
  }

  for (const key of Object.keys(environment)) {
    if (key.startsWith(MANAGED_GIT_ATTRIBUTION_PREFIX)) {
      delete environment[key];
    }
  }
}

export function createTestProcessEnvironment(source, temporaryRoot) {
  const environment = {
    ...source,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  };
  isolateManagedGitAttributionEnvironment(environment);
  return environment;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function removeOwnedTestTemporaryRoot(
  temporaryRoot,
  { maxWaitMs = 10_000, pollIntervalMs = 50, quietPeriodMs = 1_000 } = {}
) {
  const deadline = Date.now() + maxWaitMs;
  let missingSince;
  while (Date.now() <= deadline) {
    const existedBeforeRemoval = await pathExists(temporaryRoot);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    if (await pathExists(temporaryRoot)) {
      missingSince = undefined;
    } else if (existedBeforeRemoval) {
      missingSince = Date.now();
    } else {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= quietPeriodMs) return;
    }
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Owned test temporary root remained active after cleanup deadline');
}

export function reportTestTemporaryRootCleanupFailure(
  runError,
  cleanupError,
  report = console.error
) {
  if (runError instanceof Error) runError.cause = cleanupError;
  report('测试临时目录清理失败', cleanupError);
}
