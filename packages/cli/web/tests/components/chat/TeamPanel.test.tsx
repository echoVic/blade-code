// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendTeamMessage: vi.fn(async () => undefined),
  deleteTeam: vi.fn(async () => undefined),
}));

vi.mock('../../../src/services/teamService', () => ({
  teamService: {
    sendMessage: mocks.sendTeamMessage,
    delete: mocks.deleteTeam,
  },
}));

import { TeamPanel } from '../../../src/components/chat/TeamPanel';
import { setLocale } from '../../../src/i18n';
import { useSettingsStore } from '../../../src/store/SettingsStore';
import { useSessionStore } from '../../../src/store/session';

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('TeamPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const ref = {
    sessionId: 'session-1',
    projectPath: '/workspace/project',
  };
  const loadTeams = vi.fn(async () => undefined);

  beforeEach(() => {
    setLocale('en');
    mocks.sendTeamMessage.mockClear();
    mocks.deleteTeam.mockClear();
    loadTeams.mockClear();
    useSettingsStore.setState({ agentTeamsEnabled: true });
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      loadTeams,
      teams: [
        {
          name: 'review-team',
          description: 'Parallel review',
          status: 'running',
          leadAgentId: 'team-lead-review-team',
          leadSessionId: ref.sessionId,
          workspaceRoot: ref.projectPath,
          peerMessagingEnabled: true,
          createdAt: 1,
          updatedAt: 2,
          members: [
            {
              id: 'team-lead-review-team',
              name: 'team-lead',
              subagentType: 'team-lead',
              description: 'Lead',
              status: 'leader',
            },
            {
              id: 'team-reviewer-review-team',
              name: 'reviewer',
              subagentType: 'Explore',
              description: 'Review',
              agentId: 'team-reviewer-review-team',
              status: 'running',
              worktreePath: '/workspace/worktree',
            },
          ],
          tasks: [
            {
              id: '1',
              subject: 'Inspect runtime',
              description: 'Review runtime changes',
              status: 'running',
              owner: 'team-reviewer-review-team',
              priority: 'high',
              dependsOn: [],
              blocks: [],
              createdAt: '2026-08-22T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSessionStore.setState({ teams: [], currentSessionRef: null });
  });

  it('renders live members, tasks, and worktree state', async () => {
    await act(async () => {
      root.render(<TeamPanel />);
    });

    const panel = container.querySelector('[data-blade-team-panel]');
    expect(panel?.textContent).toContain('review-team');
    expect(panel?.textContent).toContain('reviewer');
    expect(panel?.textContent).toContain('Inspect runtime');
    expect(panel?.querySelector('.lucide-git-branch')).not.toBeNull();
  });

  it('sends direct teammate messages and can delete the team', async () => {
    await act(async () => {
      root.render(<TeamPanel />);
    });

    const select = container.querySelector('select');
    const input = container.querySelector('input');
    if (!select || !input) throw new Error('Team message controls are missing');

    act(() => {
      select.value = 'reviewer';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      setInputValue(input, 'Check the race condition');
    });
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send team message"]'
    );
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.sendTeamMessage).toHaveBeenCalledWith(
      ref,
      'review-team',
      'reviewer',
      'Check the race condition'
    );
    expect(loadTeams).toHaveBeenCalledWith(ref);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Delete team"]')
        ?.click();
    });
    expect(mocks.deleteTeam).toHaveBeenCalledWith(ref, 'review-team');
    expect(loadTeams).toHaveBeenLastCalledWith(ref);
  });
});
