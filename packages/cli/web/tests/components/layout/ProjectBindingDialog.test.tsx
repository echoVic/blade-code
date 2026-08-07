// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  pickProjectDirectory: vi.fn(),
}));

vi.mock('../../../src/services', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services')>(
    '../../../src/services'
  );
  return {
    ...actual,
    sessionService: {
      ...actual.sessionService,
      pickProjectDirectory: serviceMocks.pickProjectDirectory,
    },
  };
});

import { ProjectBindingDialog } from '../../../src/components/layout/ProjectBindingDialog';
import { setLocale } from '../../../src/i18n';
import { useSessionStore } from '../../../src/store/session';

describe('ProjectBindingDialog folder picker', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const bindProject = vi.fn(async () => undefined);
  const startTemporarySession = vi.fn();
  const onOpenChange = vi.fn();

  beforeEach(() => {
    setLocale('en');
    serviceMocks.pickProjectDirectory.mockReset();
    bindProject.mockClear();
    startTemporarySession.mockClear();
    onOpenChange.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      boundProjects: [],
      selectedProjectPath: null,
      isBindingProject: false,
      loadBoundProjects: vi.fn(async () => undefined),
      bindProject,
      unbindProject: vi.fn(async () => undefined),
      selectProject: vi.fn(),
      startTemporarySession,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens the native picker and binds the selected folder', async () => {
    serviceMocks.pickProjectDirectory.mockResolvedValue({
      cancelled: false,
      path: '/workspace/selected',
    });
    await act(async () => {
      root.render(<ProjectBindingDialog open onOpenChange={onOpenChange} />);
    });

    const choose = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose project folder"]'
    );
    await act(async () => {
      choose?.click();
    });

    expect(serviceMocks.pickProjectDirectory).toHaveBeenCalledOnce();
    expect(bindProject).toHaveBeenCalledWith('/workspace/selected');
    expect(startTemporarySession).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and does not bind when selection is cancelled', async () => {
    serviceMocks.pickProjectDirectory.mockResolvedValue({ cancelled: true });
    await act(async () => {
      root.render(<ProjectBindingDialog open onOpenChange={onOpenChange} />);
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Choose project folder"]')
        ?.click();
    });

    expect(bindProject).not.toHaveBeenCalled();
    expect(startTemporarySession).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('ignores a folder result that arrives after the dialog closes', async () => {
    let resolveSelection:
      | ((selection: { cancelled: false; path: string }) => void)
      | undefined;
    serviceMocks.pickProjectDirectory.mockReturnValue(
      new Promise((resolve) => {
        resolveSelection = resolve;
      })
    );
    await act(async () => {
      root.render(<ProjectBindingDialog open onOpenChange={onOpenChange} />);
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Choose project folder"]')
        ?.click();
    });

    await act(async () => {
      root.render(<ProjectBindingDialog open={false} onOpenChange={onOpenChange} />);
    });
    await act(async () => {
      resolveSelection?.({ cancelled: false, path: '/workspace/late' });
    });

    expect(bindProject).not.toHaveBeenCalled();
    expect(startTemporarySession).not.toHaveBeenCalled();
  });
});
