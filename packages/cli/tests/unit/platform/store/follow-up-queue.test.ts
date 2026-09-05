import { beforeEach, describe, expect, it } from 'vitest';
import type { FollowUpPresentation } from '../../../../src/store/types.js';
import { getState, vanillaStore } from '../../../../src/store/vanilla.js';

const queuedInput = (displayText: string): FollowUpPresentation => ({
  displayText,
  text: displayText,
  images: [],
  parts: [{ type: 'text', text: displayText }],
});

describe('TUI follow-up queue projection', () => {
  beforeEach(() => {
    vanillaStore.setState((state) => ({
      ...state,
      session: {
        ...state.session,
        sessionId: 'queue-session',
        workspaceRoot: '/queue-workspace',
      },
      app: {
        ...state.app,
        followUpQueue: null,
        followUpQueueOwner: null,
        followUpQueueMutation: { pending: false, supersededVersions: [] },
      },
      command: { ...state.command, followUpPresentations: {} },
    }));
  });

  it('bounds presentation-only input by durable message ID', () => {
    for (let index = 0; index < 21; index++) {
      getState().command.actions.rememberFollowUpPresentation(
        'message-' + index,
        queuedInput('input-' + index)
      );
    }

    expect(Object.keys(getState().command.followUpPresentations)).toHaveLength(20);
    expect(getState().command.followUpPresentations['message-0']).toBeUndefined();
    expect(
      getState().command.actions.takeFollowUpPresentation('message-20')?.displayText
    ).toBe('input-20');
    expect(getState().command.followUpPresentations['message-20']).toBeUndefined();
  });

  it('rejects a late queue snapshot from a previous Session owner', () => {
    const snapshot = {
      version: 'a'.repeat(64),
      pending: 1,
      mutable: 1,
      locked: 0,
      internal: 0,
      items: [],
    };
    getState().app.actions.projectFollowUpQueue(
      snapshot,
      ['/old-workspace', 'old-session', 'old-owner'].join('\0')
    );

    expect(getState().app.followUpQueue).toBeNull();
    getState().app.actions.claimFollowUpQueueOwner(
      ['/queue-workspace', 'queue-session', 'current-owner'].join('\0')
    );
    getState().app.actions.projectFollowUpQueue(
      snapshot,
      ['/queue-workspace', 'queue-session', 'current-owner'].join('\0')
    );
    expect(getState().app.followUpQueue).toEqual(snapshot);
  });

  it('clears queue projection and presentation cache on Session replacement', () => {
    const owner = ['/queue-workspace', 'queue-session', 'current-owner'].join('\0');
    getState().app.actions.claimFollowUpQueueOwner(owner);
    getState().app.actions.projectFollowUpQueue(
      {
        version: 'a'.repeat(64),
        pending: 1,
        mutable: 1,
        locked: 0,
        internal: 0,
        items: [],
      },
      owner
    );
    getState().command.actions.rememberFollowUpPresentation(
      'message-1',
      queuedInput('queued input')
    );

    getState().session.actions.restoreSession('replacement', [], [], '/replacement');

    expect(getState().app.followUpQueue).toBeNull();
    expect(getState().command.followUpPresentations).toEqual({});
  });

  it('rejects callbacks from a replaced owner epoch of the same Session', () => {
    const first = ['/queue-workspace', 'queue-session', 'first-owner'].join('\0');
    const second = ['/queue-workspace', 'queue-session', 'second-owner'].join('\0');
    getState().app.actions.claimFollowUpQueueOwner(first);
    getState().app.actions.claimFollowUpQueueOwner(second);
    getState().app.actions.projectFollowUpQueue(
      {
        version: 'a'.repeat(64),
        pending: 1,
        mutable: 1,
        locked: 0,
        internal: 0,
        items: [],
      },
      first
    );

    expect(getState().app.followUpQueueOwner).toBe(second);
    expect(getState().app.followUpQueue).toBeNull();
  });
});
