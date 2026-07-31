export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  message?: string;
}

export const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const waitFor = async <T>(
  condition: () => T | Promise<T>,
  options: WaitForOptions = {}
): Promise<T> => {
  const { timeout = 5000, interval = 100, message = 'Condition was not met' } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) {
        return result;
      }
    } catch {
      // Ignore errors and retry
    }
    await wait(interval);
  }

  throw new Error(`${message} within ${timeout}ms`);
};

export const waitForValue = async <T>(
  getValue: () => T | Promise<T>,
  expectedValue: T,
  options: WaitForOptions = {}
): Promise<void> => {
  await waitFor(
    async () => {
      const value = await getValue();
      return value === expectedValue;
    },
    {
      ...options,
      message: options.message || `Value did not become ${expectedValue}`,
    }
  );
};

export const waitForTruthy = async <T>(
  getValue: () => T | Promise<T>,
  options: WaitForOptions = {}
): Promise<T> => {
  return waitFor(getValue, {
    ...options,
    message: options.message || 'Value did not become truthy',
  });
};

export const waitForFalsy = async <T>(
  getValue: () => T | Promise<T>,
  options: WaitForOptions = {}
): Promise<void> => {
  await waitFor(
    async () => {
      const value = await getValue();
      return !value;
    },
    {
      ...options,
      message: options.message || 'Value did not become falsy',
    }
  );
};

export const waitForArrayLength = async <T>(
  getArray: () => T[] | Promise<T[]>,
  expectedLength: number,
  options: WaitForOptions = {}
): Promise<T[]> => {
  return waitFor(
    async () => {
      const arr = await getArray();
      return arr.length === expectedLength ? arr : null;
    },
    {
      ...options,
      message: options.message || `Array length did not become ${expectedLength}`,
    }
  ) as Promise<T[]>;
};

export const waitForArrayNotEmpty = async <T>(
  getArray: () => T[] | Promise<T[]>,
  options: WaitForOptions = {}
): Promise<T[]> => {
  return waitFor(
    async () => {
      const arr = await getArray();
      return arr.length > 0 ? arr : null;
    },
    {
      ...options,
      message: options.message || 'Array did not become non-empty',
    }
  ) as Promise<T[]>;
};

export const waitForNoThrow = async (
  fn: () => unknown | Promise<unknown>,
  options: WaitForOptions = {}
): Promise<void> => {
  await waitFor(
    async () => {
      try {
        await fn();
        return true;
      } catch {
        return false;
      }
    },
    {
      ...options,
      message: options.message || 'Function continued to throw',
    }
  );
};

export const waitForThrow = async (
  fn: () => unknown | Promise<unknown>,
  options: WaitForOptions = {}
): Promise<Error> => {
  return waitFor(
    async () => {
      try {
        await fn();
        return null;
      } catch (error) {
        return error as Error;
      }
    },
    {
      ...options,
      message: options.message || 'Function did not throw',
    }
  ) as Promise<Error>;
};

export const retryAsync = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 100
): Promise<T> => {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await wait(delay);
      }
    }
  }

  throw lastError;
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeout: number,
  message = 'Operation timed out'
): Promise<T> => {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeout);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
};

export const debounceAsync = <T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => Promise<ReturnType<T>>) => {
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingPromise: Promise<ReturnType<T>> | null = null;

  return (...args: Parameters<T>): Promise<ReturnType<T>> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    pendingPromise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(async () => {
        try {
          const result = await fn(...args);
          resolve(result as ReturnType<T>);
        } catch (error) {
          reject(error);
        }
      }, delay);
    });

    return pendingPromise;
  };
};
