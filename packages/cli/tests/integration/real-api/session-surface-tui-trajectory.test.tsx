import { mkdtemp, rm } from 'node:fs/promises';
import type { SocketReadyState } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import React, { useEffect, useState } from 'react';
import { describe, expect, it, type TestContext } from 'vitest';
import type { SessionSurfaceSummary } from '../../../src/api/sessionSurfaceSchemas.js';
import { SessionSurfaceService } from '../../../src/services/SessionSurfaceService.js';
import { FocusId } from '../../../src/store/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { SessionHistoryViewer } from '../../../src/ui/components/SessionHistoryViewer.js';
import { SessionSelector } from '../../../src/ui/components/SessionSelector.js';
import {
  TerminalInputRouterProvider,
  useTerminalInput,
} from '../../../src/ui/input/TerminalInputRouter.js';
import { SessionHistoryController } from '../../../src/ui/services/SessionHistoryController.js';
import { createPairedAcpProductionFixture } from '../../support/acp/remoteFilesystemQualification.js';
import {
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const describeReal = models.length === 2 ? describe.sequential : describe.skip;

class TestInputStream extends PassThrough {
  public isTTY = true;
  public isRaw = false;
  public isRawMode = false;
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.isRawMode = mode;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class TestOutputStream extends PassThrough {
  public columns = 120;
  public rows = 40;
  public isTTY = true;
  public output = '';
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  constructor() {
    super();
    this.on('data', (chunk: string | Buffer) => {
      this.output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
  }

  clearLine(_direction: -1 | 0 | 1, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  clearScreenDown(callback?: () => void): boolean {
    callback?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), callback?: () => void): boolean {
    if (typeof _y === 'function') _y();
    else callback?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

function retryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw lastError;
}

function assertNoPrivateValues(output: string, privateValues: readonly string[]): void {
  for (const secret of privateValues) {
    if (secret) expect(output).not.toContain(secret);
  }
}

function InputReadyProbe({ onReady }: { onReady: () => void }): null {
  useTerminalInput(() => false, {
    isActive: true,
    priority: -100,
    onRegistered: onReady,
  });
  return null;
}

describeReal('production TUI remote Session history trajectory', () => {
  for (const model of models) {
    it(`${model.qualificationId} uses real Ink input without remote execution`, async (context) => {
      const frameworkRetryBudget = retryBudget(context);
      expect(frameworkRetryBudget).toBe(0);
      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), 'blade-session-surface-tui-')
      );
      const fixture = await createPairedAcpProductionFixture({
        model,
        frameworkRetryBudget,
        fixtureRoot,
      });
      try {
        await fixture.withSessionRef(async (reference) => {
          const controller = new SessionHistoryController({
            serviceFactory: () => new SessionSurfaceService(),
            pageLimit: 20,
          });
          const candidates = await controller.listAll();
          const remoteRows = candidates.filter(
            (candidate) =>
              candidate.locator.workspace.kind === 'acp-remote' &&
              candidate.locator.sessionId === reference.sessionId &&
              candidate.locator.workspace.workspaceRef === reference.workspaceRef
          );
          expect(remoteRows).toHaveLength(1);
          const target = remoteRows[0]!;
          getState().session.actions.restoreSession(
            'qualification-live-local',
            [
              {
                id: 'qualification-live-message',
                role: 'user',
                content: 'local live state',
                timestamp: 1,
              },
            ],
            [],
            '/qualification/local'
          );
          const preservedSession = getState().session;
          getState().focus.actions.setFocus(FocusId.SESSION_SELECTOR);
          const beforeCounts = reference.readActivityCounts();
          const sourceTranscript = await reference.readTranscript();
          const stdin = new TestInputStream();
          const stdout = new TestOutputStream();
          const stderr = new TestOutputStream();
          let closed = false;
          let historyInputReady = false;

          function Harness(): React.ReactElement | null {
            const [screen, setScreen] = useState<'selector' | 'history' | 'closed'>(
              'selector'
            );
            const [history, setHistory] = useState(controller.getState());
            useEffect(() => controller.subscribe(setHistory), []);
            useEffect(() => {
              getState().focus.actions.setFocus(
                screen === 'history'
                  ? FocusId.SESSION_HISTORY_VIEWER
                  : screen === 'selector'
                    ? FocusId.SESSION_SELECTOR
                    : FocusId.MAIN_INPUT
              );
            }, [screen]);
            if (screen === 'closed') return null;
            if (screen === 'selector') {
              return (
                <SessionSelector
                  intent="resume"
                  sessions={[target]}
                  onSelect={async (summary: SessionSurfaceSummary) => {
                    setScreen('history');
                    await controller.activate(summary, 'resume');
                  }}
                />
              );
            }
            return (
              <>
                <SessionHistoryViewer
                  state={history}
                  onLoadOlder={(action) => controller.loadOlder(action)}
                  onFork={(action) => controller.fork(action)}
                  onClose={() => {
                    void controller.closeView().then(() => {
                      closed = true;
                      setScreen('closed');
                    });
                  }}
                />
                <InputReadyProbe onReady={() => (historyInputReady = true)} />
              </>
            );
          }

          const app = render(
            <TerminalInputRouterProvider>
              <Harness />
            </TerminalInputRouterProvider>,
            {
              stdin: stdin as unknown as NodeJS.ReadStream,
              stdout: stdout as unknown as NodeJS.WriteStream,
              stderr: stderr as unknown as NodeJS.WriteStream,
              debug: true,
              exitOnCtrlC: false,
              patchConsole: false,
            }
          );
          const exitPromise = app.waitUntilExit();
          try {
            await waitForAssertion(() => {
              expect(stdin.isRaw).toBe(true);
              expect(stdout.output).toContain('[remote · offline · history]');
            });
            stdin.write('\r');
            await waitForAssertion(() => {
              expect(controller.getState().status).toBe('ready');
              expect(stdout.output).toContain('Remote · offline · History only');
              expect(getState().focus.currentFocus).toBe(
                FocusId.SESSION_HISTORY_VIEWER
              );
              expect(controller.getState().olderCursor).toBeTruthy();
              expect(historyInputReady).toBe(true);
              expect(stdout.output).toContain(reference.remoteWorkspacePath);
              expect(stdout.output).toContain('Qualification history page item 054');
            });
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            expect(getState().session).toBe(preservedSession);

            stdin.write('g');
            await waitForAssertion(() => {
              expect(controller.getState().messages.length).toBeGreaterThan(20);
            });
            const searchEditorStart = stdout.output.length;
            stdin.write('/');
            await waitForAssertion(() => {
              expect(stdout.output.slice(searchEditorStart)).toMatch(
                /(?:^|\n)\s*\/\s*(?:\n|$)/
              );
            });
            stdin.write('Qualification');
            await waitForAssertion(() => {
              expect(stdout.output.slice(searchEditorStart)).toContain(
                '/Qualification'
              );
            });
            stdin.write('\r');
            await waitForAssertion(() => {
              expect(stdout.output).toMatch(
                /\/Qualification \d+\/\d+ · loaded pages only/
              );
            });
            stdin.write('y');
            await waitForAssertion(() => {
              expect(stdout.output).toMatch(/Copied|Copy failed/);
            });
            const parentSessionId = controller.getState().session?.locator.sessionId;
            stdin.write('f');
            await waitForAssertion(() => {
              const state = controller.getState();
              expect(state.status).toBe('ready');
              expect(state.session?.locator.sessionId).not.toBe(parentSessionId);
              expect(state.session?.locator.workspace.kind).toBe('acp-remote');
            });
            stdin.write('\u001b');
            await waitForAssertion(() => expect(closed).toBe(true));
            expect(getState().session).toBe(preservedSession);
            expect(reference.readActivityCounts()).toEqual(beforeCounts);
            expect(await reference.readTranscript()).toBe(sourceTranscript);
            assertNoPrivateValues(
              `${stdout.output}\n${stderr.output}`,
              reference.forbiddenSurfaceValues
            );
          } finally {
            app.unmount();
            await exitPromise;
            app.cleanup();
            stdin.end();
            stdout.end();
            stderr.end();
            await controller.close();
            getState().session.actions.resetSession();
            getState().focus.actions.setFocus(FocusId.MAIN_INPUT);
          }
          return undefined;
        });
      } finally {
        await fixture.cleanup();
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
