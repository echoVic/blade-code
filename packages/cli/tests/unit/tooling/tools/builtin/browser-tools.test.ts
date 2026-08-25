import { describe, expect, it, vi } from 'vitest';
import type { SessionBrowserRuntime } from '../../../../../src/browser/SessionBrowserRuntime.js';
import { PermissionMode } from '../../../../../src/config/types.js';
import { createBrowserTools } from '../../../../../src/tools/builtin/browser/browserTools.js';
import { toolSearchTool } from '../../../../../src/tools/builtin/system/ToolSearchTool.js';
import { ToolExecutor } from '../../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../../../src/tools/types/index.js';

function createRuntime(): SessionBrowserRuntime {
  const observation = {
    pageId: 'browser_page_test',
    snapshotId: 'browser_snapshot_test',
    url: 'https://example.com/',
    origin: 'https://example.com:443',
    title: 'Example',
    tabs: [],
    snapshot: '- button "Save" [ref=e1]',
    truncated: false,
  };
  return {
    navigate: vi.fn(async () => observation),
    snapshot: vi.fn(async () => observation),
    interact: vi.fn(async () => ({
      outcome: 'applied' as const,
      pageId: observation.pageId,
      actionApplied: true as const,
      sideEffectsUncertain: false as const,
      observation,
    })),
    wait: vi.fn(async () => observation),
    inspect: vi.fn(async () => ({
      pageId: observation.pageId,
      target: 'console' as const,
      entries: [],
      truncated: false,
    })),
    page: vi.fn(async () => ({
      tabs: [],
    })),
  } as unknown as SessionBrowserRuntime;
}

describe('native Browser tools', () => {
  it('registers the exact deferred catalog with frozen kinds', () => {
    const tools = createBrowserTools(createRuntime());
    expect(tools.map((tool) => tool.name)).toEqual([
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserInteract',
      'BrowserWait',
      'BrowserInspect',
      'BrowserPage',
    ]);
    expect(tools.map((tool) => tool.kind)).toEqual([
      ToolKind.Execute,
      ToolKind.ReadOnly,
      ToolKind.Execute,
      ToolKind.ReadOnly,
      ToolKind.ReadOnly,
      ToolKind.Execute,
    ]);
    expect(tools.every((tool) => tool.parallelism === 'exclusive')).toBe(true);

    const registry = new ToolRegistry();
    registry.registerAll(tools);
    expect(
      registry
        .getFunctionDeclarationsByMode(PermissionMode.PLAN)
        .map((declaration) => declaration.name)
    ).not.toContain('BrowserSnapshot');
    expect(registry.getDeferredToolsListing()).toBe(
      [
        '<available-deferred-tools>',
        'BrowserInspect',
        'BrowserInteract',
        'BrowserNavigate',
        'BrowserPage',
        'BrowserSnapshot',
        'BrowserWait',
        '</available-deferred-tools>',
      ].join('\n')
    );
  });

  it('loads all six schemas through one exact ToolSearch call', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createBrowserTools(createRuntime()));

    const result = await toolSearchTool.execute(
      {
        query:
          'select:BrowserNavigate,BrowserSnapshot,BrowserInteract,BrowserWait,BrowserInspect,BrowserPage',
        max_results: 6,
      },
      undefined,
      {
        toolRegistry: registry,
        deferredToolManager: registry.deferredToolManager,
      }
    );

    expect(result.success).toBe(true);
    for (const name of [
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserInteract',
      'BrowserWait',
      'BrowserInspect',
      'BrowserPage',
    ]) {
      expect(registry.deferredToolManager.isLoaded(name)).toBe(true);
      expect(String(result.llmContent)).toContain(`"name":"${name}"`);
    }
    const planTools = registry
      .getFunctionDeclarationsByMode(PermissionMode.PLAN)
      .map((declaration) => declaration.name);
    expect(planTools).toContain('BrowserSnapshot');
    expect(planTools).toContain('BrowserWait');
    expect(planTools).toContain('BrowserInspect');
    expect(planTools).not.toContain('BrowserNavigate');
    expect(planTools).not.toContain('BrowserInteract');
    expect(planTools).not.toContain('BrowserPage');
  });

  it('scopes permission signatures without query or typed values', () => {
    const tools = createBrowserTools(createRuntime());
    const navigate = tools.find((tool) => tool.name === 'BrowserNavigate')!;
    const interact = tools.find((tool) => tool.name === 'BrowserInteract')!;
    const page = tools.find((tool) => tool.name === 'BrowserPage')!;

    expect(
      navigate.extractSignatureContent?.({
        action: 'goto',
        url: 'https://example.com/path?token=secret',
        waitUntil: 'load',
        timeoutMs: 1000,
      })
    ).toBe('https://example.com:443');
    expect(
      interact.extractSignatureContent?.({
        pageId: 'browser_page_test',
        snapshotId: 'browser_snapshot_test',
        ref: 'e1',
        expectedOrigin: 'https://example.com:443',
        action: { kind: 'fill', value: 'private-value' },
        timeoutMs: 1000,
      })
    ).toBe('https://example.com:443');
    expect(
      page.extractSignatureContent?.({
        action: { kind: 'close', pageId: 'browser_page_test' },
      })
    ).toBe('close');
  });

  it('returns bounded untrusted Browser output', async () => {
    const runtime = createRuntime();
    const snapshot = createBrowserTools(runtime).find(
      (tool) => tool.name === 'BrowserSnapshot'
    )!;
    const result = await snapshot.execute({});

    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('<browser_data trust="untrusted">');
    expect(result.metadata).toMatchObject({
      summary: 'BrowserSnapshot: ok',
      browser: {
        action: 'BrowserSnapshot',
        pageId: 'browser_page_test',
        snapshotId: 'browser_snapshot_test',
      },
    });
  });

  it('projects uncertain interactions as failures without losing side-effect state', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.interact).mockResolvedValueOnce({
      outcome: 'uncertain',
      pageId: 'browser_page_test',
      actionApplied: 'unknown',
      sideEffectsUncertain: true,
      errorCode: 'browser_timeout',
    });
    const interact = createBrowserTools(runtime).find(
      (tool) => tool.name === 'BrowserInteract'
    )!;
    const result = await interact.execute({
      pageId: 'browser_page_test',
      snapshotId: 'browser_snapshot_test',
      ref: 'e1',
      expectedOrigin: 'https://example.com:443',
      action: { kind: 'click' },
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'browser_timeout' },
      metadata: {
        browser: {
          actionApplied: 'unknown',
          sideEffectsUncertain: true,
        },
      },
    });
  });

  it('requests permission with an origin-scoped Browser preview', async () => {
    const runtime = createRuntime();
    const registry = new ToolRegistry();
    registry.registerAll(createBrowserTools(runtime));
    const executor = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['BrowserNavigate(*)', 'BrowserInteract(*)'],
        deny: [],
      },
    });
    const requestConfirmation = vi.fn(async () => ({
      approved: true,
      scope: 'once' as const,
    }));

    const result = await executor.execute(
      'BrowserNavigate',
      {
        action: 'goto',
        url: 'https://example.com/path?token=private',
        waitUntil: 'load',
        timeoutMs: 1000,
      },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: { requestConfirmation },
      }
    );

    expect(result.success).toBe(true);
    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'https://example.com:443',
        details: 'Origin: https://example.com:443\nNetwork: public',
        risks: expect.arrayContaining([
          'The page may execute remote code and issue network requests',
        ]),
      })
    );

    await executor.execute(
      'BrowserNavigate',
      {
        action: 'reload',
        pageId: 'browser_page_test',
        expectedOrigin: 'HTTPS://EXAMPLE.COM:443',
        waitUntil: 'load',
        timeoutMs: 1000,
      },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: { requestConfirmation },
      }
    );
    await executor.execute(
      'BrowserInteract',
      {
        pageId: 'browser_page_test',
        snapshotId: 'browser_snapshot_test',
        ref: 'e1',
        expectedOrigin: 'HTTPS://EXAMPLE.COM:443',
        action: { kind: 'click' },
        timeoutMs: 1000,
      },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: { requestConfirmation },
      }
    );

    expect(requestConfirmation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        details: 'Origin: https://example.com:443\nNetwork: public',
      })
    );
    expect(requestConfirmation).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        details: 'Origin: https://example.com:443\nNetwork: public\nAction: click',
      })
    );
    executor.dispose();
  });
});
