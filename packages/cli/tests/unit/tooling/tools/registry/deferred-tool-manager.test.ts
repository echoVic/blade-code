import { describe, expect, it } from 'vitest';
import { DeferredToolManager } from '../../../../../src/tools/registry/DeferredToolManager.js';

describe('DeferredToolManager', () => {
  it('always loads WriteStdin with its Bash and TaskOutput companions', () => {
    const manager = new DeferredToolManager();

    manager.register('WriteStdin');

    expect(manager.isLoaded('WriteStdin')).toBe(true);
    expect(manager.getDeferredToolNames()).not.toContain('WriteStdin');
  });

  it('renders deferred tool names in a cache-stable order', () => {
    const manager = new DeferredToolManager();

    manager.register('ZuluTool');
    manager.register('AlphaTool');
    manager.register('MiddleTool');

    expect(manager.getDeferredToolNames()).toEqual([
      'AlphaTool',
      'MiddleTool',
      'ZuluTool',
    ]);
    expect(manager.getDeferredToolsListing()).toBe(
      '<available-deferred-tools>\nAlphaTool\nMiddleTool\nZuluTool\n</available-deferred-tools>'
    );
  });
});
