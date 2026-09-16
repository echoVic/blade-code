import { expect } from 'vitest';
import type { BrowserToolFixture } from '../integration/real-api/browser-tool-fixture.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';
import { ensureYoloMode } from './webTestUtils.js';

export interface BrowserToolWebEvidence {
  sessionId: string;
  markerVisible: true;
  markerVisibleAfterReload: true;
  agentBrowserProjected: true;
  toolNames: string[];
  browserFaults: [];
}

async function waitForMarker(input: {
  page: import('playwright').Page;
  origin: string;
  workspace: string;
  sessionId: string;
  marker: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastStatus: unknown = 'unknown';
  while (Date.now() < deadline) {
    const assistant = input.page
      .locator('[data-chat-role="assistant"]')
      .filter({ hasText: input.marker })
      .last();
    const markerVisible =
      (await assistant.count()) > 0 && (await assistant.isVisible());
    const response = await fetch(
      `${input.origin}/sessions/${encodeURIComponent(
        input.sessionId
      )}/status?projectPath=${encodeURIComponent(input.workspace)}`
    );
    if (response.ok) {
      lastStatus = ((await response.json()) as { status?: unknown }).status;
      if (markerVisible && lastStatus === 'completed') return;
      if (
        lastStatus === 'failed' ||
        lastStatus === 'cancelled' ||
        lastStatus === 'interrupted' ||
        lastStatus === 'waiting_permission'
      ) {
        const cards = await input.page
          .locator('[data-tool-name]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              name: element.getAttribute('data-tool-name'),
              status: element.getAttribute('data-tool-status'),
            }))
          );
        const assistantText = await input.page
          .locator('[data-chat-role="assistant"]')
          .allTextContents();
        throw new Error(
          `Browser Tool Web run reached ${String(
            lastStatus
          )}; cards=${JSON.stringify(cards)}; assistant=${JSON.stringify(
            assistantText.slice(-3).map((text) => text.slice(-1_024))
          )}`
        );
      }
    }
    await input.page.waitForTimeout(250);
  }
  throw new Error(
    `Browser Tool Web marker timed out with status ${String(lastStatus)}`
  );
}

export async function runBrowserToolWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  fixture: BrowserToolFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<BrowserToolWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 240_000;
  return withBladeWebTest(
    input,
    {
      context: { viewport: { width: 1440, height: 900 } },
      includeHttpErrors: false,
    },
    async ({ server, origin, page, faults, state }) => {
      try {
        const create = await fetch(`${origin}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: input.workspace,
            title: 'Browser Tool qualification',
          }),
        });
        if (!create.ok) throw new Error(`Session create failed: ${create.status}`);
        const created = (await create.json()) as { sessionId?: unknown };
        if (typeof created.sessionId !== 'string') {
          throw new Error('Browser Tool Web Session returned no ID');
        }

        const navigation = new URL(origin);
        navigation.searchParams.set('session', created.sessionId);
        navigation.searchParams.set('project', input.workspace);
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        await ensureYoloMode(page);
        await composer.fill(input.fixture.prompt);
        await composer.press('Enter');
        const browserPanel = page.locator('[data-browser-panel]');
        await browserPanel.waitFor({ state: 'visible', timeout: timeoutMs });
        await page.waitForFunction(
          () => {
            const panel = document.querySelector('[data-browser-panel]');
            return (
              panel?.getAttribute('data-browser-mode') === 'test' &&
              panel.getAttribute('data-browser-test-source') === 'agent'
            );
          },
          undefined,
          { timeout: timeoutMs }
        );
        await page
          .locator('[data-browser-test-screenshot]')
          .waitFor({ state: 'visible', timeout: timeoutMs });
        await page
          .locator('[data-browser-agent-pointer]')
          .waitFor({ state: 'visible', timeout: timeoutMs });
        const browserAddress = page.locator('[data-browser-panel-address]');
        expect(await browserAddress.getAttribute('readonly')).not.toBeNull();
        expect(
          await page
            .getByRole('button', { name: 'Click selected element' })
            .isDisabled()
        ).toBe(true);
        await waitForMarker({
          page,
          origin,
          workspace: input.workspace,
          sessionId: created.sessionId,
          marker: input.fixture.finalMarker,
          timeoutMs,
        });

        const toolNames = await page
          .locator('[data-tool-name]')
          .evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute('data-tool-name'))
              .filter((name): name is string => Boolean(name))
          );
        if ((await page.locator('body').textContent())?.includes(input.secret)) {
          throw new Error('Provider credential reached the Browser Tool Web DOM');
        }

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: input.fixture.finalMarker })
          .last()
          .waitFor({ state: 'visible', timeout: 30_000 });
        if (faults.length > 0) {
          throw new Error(`Browser Tool Web faults: ${JSON.stringify(faults)}`);
        }
        return {
          sessionId: created.sessionId,
          markerVisible: true,
          markerVisibleAfterReload: true,
          agentBrowserProjected: true,
          toolNames,
          browserFaults: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message.replaceAll(input.secret, '[REDACTED]')}; server=${server.output
            .replaceAll(input.secret, '[REDACTED]')
            .slice(-2_000)}`
        );
      }
    }
  );
}
