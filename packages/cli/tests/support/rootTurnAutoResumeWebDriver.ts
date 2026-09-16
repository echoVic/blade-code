import type { Page } from 'playwright';
import { waitForInboxRemoval } from './asyncTestUtils.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';

export interface RootTurnAutoResumeWebEvidence {
  attentionVisible: true;
  attentionVisibleAfterReload: true;
  markerVisible: true;
  markerVisibleAfterReload: true;
  composerVisible: true;
  browserFaults: [];
}

const ROOT_TURN_RESPONSE_PREFIX = 'ROOT_TURN_RECOVERED_';

async function waitForExpectedAssistantText(
  page: Page,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const assistant = page.locator('[data-chat-role="assistant"]');
  const deadline = Date.now() + timeoutMs;
  let prefixObservedAt: number | undefined;
  let observedTexts: string[] = [];

  while (Date.now() < deadline) {
    observedTexts = await assistant.allTextContents();
    if (observedTexts.some((text) => text.includes(expected))) return;
    if (observedTexts.some((text) => text.includes(ROOT_TURN_RESPONSE_PREFIX))) {
      prefixObservedAt ??= Date.now();
      if (Date.now() - prefixObservedAt >= 2_000) {
        throw new Error(
          `Root-turn Web response completed without the exact marker; assistant=${JSON.stringify(
            observedTexts.slice(-3).map((text) => text.slice(-1_024))
          )}`
        );
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `Timed out waiting for the root-turn Web response; assistant=${JSON.stringify(
      observedTexts.slice(-3).map((text) => text.slice(-1_024))
    )}`
  );
}

export async function runRootTurnAutoResumeWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  expected: string;
  secret: string;
  timeoutMs?: number;
}): Promise<RootTurnAutoResumeWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  return withBladeWebTest(
    input,
    {},
    async ({ server, origin, page, faults, state }) => {
      try {
        const navigation = new URL(origin);
        navigation.searchParams.set('session', input.sessionId);
        navigation.searchParams.set('project', input.workspace);
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        await page.locator('textarea[data-blade-composer]').waitFor({
          state: 'visible',
          timeout: 30_000,
        });
        const attention = page.getByText(/Recovery needs review|恢复前需要检查/);
        await attention.waitFor({ state: 'visible', timeout: 30_000 });
        if (
          (await page
            .locator('[data-chat-role="assistant"]')
            .filter({ hasText: input.expected })
            .count()) > 0
        ) {
          throw new Error('Root-turn Web recovery replayed before explicit input');
        }
        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        await attention.waitFor({ state: 'visible', timeout: 30_000 });
        await composer.fill(
          'I inspected the workspace and external state. Continue safely without ' +
            'repeating any write or other side effect.'
        );
        await composer.press('Enter');
        await waitForExpectedAssistantText(page, input.expected, timeoutMs);
        await attention.waitFor({ state: 'hidden', timeout: 30_000 });
        await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
        if ((await page.locator('body').textContent())?.includes(input.secret)) {
          throw new Error('Provider credential reached the browser DOM');
        }

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await page.locator('textarea[data-blade-composer]').waitFor({
          state: 'visible',
          timeout: 30_000,
        });
        await waitForExpectedAssistantText(page, input.expected, 30_000);
        await page.waitForTimeout(500);
        if (faults.length > 0) {
          throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
        }
        return {
          attentionVisible: true,
          attentionVisibleAfterReload: true,
          markerVisible: true,
          markerVisibleAfterReload: true,
          composerVisible: true,
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
