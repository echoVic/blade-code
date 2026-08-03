import { describe, expect, it } from 'vitest';
import { DeferredToolManager } from '../../../../../src/tools/registry/DeferredToolManager.js';

describe('DeferredToolManager', () => {
  it('always loads WriteStdin with its Bash and TaskOutput companions', () => {
    const manager = new DeferredToolManager();

    manager.register('WriteStdin');

    expect(manager.isLoaded('WriteStdin')).toBe(true);
    expect(manager.getDeferredToolNames()).not.toContain('WriteStdin');
  });
});
