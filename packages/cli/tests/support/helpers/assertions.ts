import { expect } from 'vitest';

export const assertFileExists = async (filePath: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
};

export const assertFileNotExists = async (filePath: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(filePath);
    throw new Error(`Expected file to not exist: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};

export const assertFileContains = async (
  filePath: string,
  content: string
): Promise<void> => {
  const fs = await import('node:fs/promises');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  expect(fileContent).toContain(content);
};

export const assertFileEquals = async (
  filePath: string,
  expectedContent: string
): Promise<void> => {
  const fs = await import('node:fs/promises');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  expect(fileContent).toBe(expectedContent);
};

export const assertFileMatchesSnapshot = async (filePath: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  expect(fileContent).toMatchSnapshot();
};

export const assertJsonFileEquals = async (
  filePath: string,
  expectedObject: unknown
): Promise<void> => {
  const fs = await import('node:fs/promises');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(fileContent);
  expect(parsed).toEqual(expectedObject);
};

export const assertJsonFileContains = async (
  filePath: string,
  expectedPartial: Record<string, unknown>
): Promise<void> => {
  const fs = await import('node:fs/promises');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(fileContent);
  expect(parsed).toMatchObject(expectedPartial);
};

export const assertDirectoryExists = async (dirPath: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      throw new Error(`Expected directory but found file: ${dirPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Expected directory to exist: ${dirPath}`);
    }
    throw error;
  }
};

export const assertDirectoryNotExists = async (dirPath: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  try {
    await fs.stat(dirPath);
    throw new Error(`Expected directory to not exist: ${dirPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};

export const assertArrayContainsAll = <T>(actual: T[], expected: T[]): void => {
  for (const item of expected) {
    expect(actual).toContain(item);
  }
};

export const assertArrayContainsNone = <T>(actual: T[], excluded: T[]): void => {
  for (const item of excluded) {
    expect(actual).not.toContain(item);
  }
};

export const assertObjectHasKeys = (
  obj: Record<string, unknown>,
  keys: string[]
): void => {
  for (const key of keys) {
    expect(obj).toHaveProperty(key);
  }
};

export const assertObjectMissingKeys = (
  obj: Record<string, unknown>,
  keys: string[]
): void => {
  for (const key of keys) {
    expect(obj).not.toHaveProperty(key);
  }
};

export const assertThrowsAsync = async (
  fn: () => Promise<unknown>,
  expectedError?: string | RegExp
): Promise<void> => {
  let threw = false;
  let error: Error | undefined;

  try {
    await fn();
  } catch (e) {
    threw = true;
    error = e as Error;
  }

  expect(threw).toBe(true);

  if (expectedError) {
    if (typeof expectedError === 'string') {
      expect(error?.message).toContain(expectedError);
    } else {
      expect(error?.message).toMatch(expectedError);
    }
  }
};

export const assertNoThrowAsync = async (fn: () => Promise<unknown>): Promise<void> => {
  let error: Error | undefined;

  try {
    await fn();
  } catch (e) {
    error = e as Error;
  }

  expect(error).toBeUndefined();
};

export const assertCalledWith = (
  mockFn: ReturnType<typeof import('vitest').vi.fn>,
  ...args: unknown[]
): void => {
  expect(mockFn).toHaveBeenCalledWith(...args);
};

export const assertCalledTimes = (
  mockFn: ReturnType<typeof import('vitest').vi.fn>,
  times: number
): void => {
  expect(mockFn).toHaveBeenCalledTimes(times);
};

export const assertNeverCalled = (
  mockFn: ReturnType<typeof import('vitest').vi.fn>
): void => {
  expect(mockFn).not.toHaveBeenCalled();
};

export const assertEventuallyTrue = async (
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Condition did not become true within ${timeout}ms`);
};
