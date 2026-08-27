import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserActivityStore } from '../../src/store/BrowserActivityStore';

const ref = {
  sessionId: 'session-1',
  projectPath: '/workspace/project',
};

describe('BrowserActivityStore', () => {
  beforeEach(() => {
    useBrowserActivityStore.getState().clearAgentActivity();
  });

  it('tracks a live Agent interaction without retaining typed values', () => {
    useBrowserActivityStore.getState().beginAgentActivity(ref, {
      toolCallId: 'tool-1',
      toolName: 'BrowserInteract',
      argumentsValue: JSON.stringify({
        pageId: 'browser_page_1',
        snapshotId: 'browser_snapshot_1',
        ref: 'e7',
        expectedOrigin: 'https://example.com:443',
        action: { kind: 'fill', value: 'private value' },
      }),
    });

    expect(useBrowserActivityStore.getState().agentActivity).toMatchObject({
      sessionRef: ref,
      toolCallId: 'tool-1',
      toolName: 'BrowserInteract',
      phase: 'running',
      pendingAction: { action: 'fill', ref: 'e7' },
    });
    expect(
      JSON.stringify(useBrowserActivityStore.getState().agentActivity)
    ).not.toContain('private value');
  });

  it('projects the latest frame and interaction geometry', () => {
    useBrowserActivityStore.getState().completeAgentActivity(ref, {
      toolCallId: 'tool-1',
      toolName: 'BrowserInteract',
      success: true,
      metadata: {
        browser: {
          action: 'BrowserInteract',
          status: 'ok',
          pageId: 'browser_page_1',
          origin: 'https://example.com:443',
          url: 'https://example.com/form',
          title: 'Example',
          interaction: {
            action: 'click',
            ref: 'e2',
            viewport: { width: 1440, height: 900 },
            targetBox: { x: 100, y: 200, width: 80, height: 40 },
          },
        },
      },
    });

    expect(useBrowserActivityStore.getState().agentActivity).toMatchObject({
      phase: 'ready',
      frameRevision: 1,
      pointerRevision: 1,
      pageId: 'browser_page_1',
      url: 'https://example.com/form',
      interaction: {
        action: 'click',
        ref: 'e2',
        viewport: { width: 1440, height: 900 },
        targetBox: { x: 100, y: 200, width: 80, height: 40 },
      },
    });
  });

  it('projects a screenshot-authorized coordinate click', () => {
    useBrowserActivityStore.getState().completeAgentActivity(ref, {
      toolCallId: 'tool-coordinate',
      toolName: 'BrowserInteract',
      success: true,
      metadata: {
        browser: {
          action: 'BrowserInteract',
          status: 'ok',
          pageId: 'browser_page_1',
          interaction: {
            action: 'click_at',
            viewport: { width: 1440, height: 900 },
            targetBox: { x: 640, y: 420, width: 1, height: 1 },
          },
        },
      },
    });

    expect(useBrowserActivityStore.getState().agentActivity).toMatchObject({
      interaction: {
        action: 'click_at',
        targetBox: { x: 640, y: 420, width: 1, height: 1 },
      },
      pointerRevision: 1,
    });
  });
});
