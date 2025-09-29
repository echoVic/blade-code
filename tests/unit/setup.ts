import { afterEach, vi } from 'vitest';

// Mock 'fs' and its 'promises' property
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      access: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    },
  };
});

// Mock 'path' to ensure default export is handled correctly
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return {
    ...actual,
    default: actual,
  };
});

// Mock 'axios' to provide a default export with a 'create' method
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  const mockAxios = {
    ...actual,
    create: vi.fn(() => mockAxios),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return {
    default: mockAxios,
  };
});

// Global test lifecycle hooks
afterEach(() => {
  vi.clearAllMocks();
});
