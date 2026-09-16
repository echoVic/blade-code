import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForInboxRemoval } from './asyncTestUtils.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';

export interface BackgroundSubagentCompletionWebEvidence {
  childSessionId: string;
  childVisible: true;
  parentVisible: true;
  noFakeUserMessage: true;
  providerAdmissionVisible: true;
  visibleAfterReload: true;
  sidecarStableAcrossReload: true;
  browserFaults: [];
}

export async function runBackgroundSubagentCompletionWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  childMarker: string;
  secret: string;
  timeoutMs?: number;
}): Promise<BackgroundSubagentCompletionWebEvidence> {
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
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page.getByText('Capacity queue', { exact: false }).waitFor({
          state: 'visible',
          timeout: 60_000,
        });
        const childCard = page.locator('[data-subagent-session-id]').last();
        const parentMessage = page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: `BACKGROUND_PARENT_FINAL:${input.childMarker}` })
          .last();
        await parentMessage.waitFor({ state: 'visible', timeout: timeoutMs });
        await childCard.waitFor({ state: 'visible', timeout: 30_000 });
        const childSessionId = await childCard.getAttribute('data-subagent-session-id');
        if (!childSessionId) {
          throw new Error('Background completion Web card has no durable child ID');
        }
        const liveChildText = (await childCard.textContent()) ?? '';
        await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
        if (
          (await page
            .locator('[data-chat-role="user"]')
            .filter({ hasText: input.childMarker })
            .count()) !== 0
        ) {
          throw new Error('Web rendered the hidden completion as a user message');
        }
        if ((await page.locator('body').textContent())?.includes(input.secret)) {
          throw new Error('Provider credential reached the background completion DOM');
        }
        const sidecarPath = path.join(
          input.storageRoot,
          'agents',
          'sessions',
          `${childSessionId}.json`
        );
        const sidecarBeforeReload = await readFile(sidecarPath, 'utf8');

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        const reloadedChildCard = page.locator(
          `[data-subagent-session-id="${childSessionId}"]`
        );
        await reloadedChildCard.waitFor({ state: 'visible', timeout: 30_000 });
        const reloadedChildText = (await reloadedChildCard.textContent()) ?? '';
        await parentMessage.waitFor({ state: 'visible', timeout: 30_000 });
        if ((await page.locator('body').textContent())?.includes('Capacity queue')) {
          throw new Error('Web reload restored transient Provider admission state');
        }
        const sidecarAfterReload = await readFile(sidecarPath, 'utf8');
        if (sidecarAfterReload !== sidecarBeforeReload) {
          throw new Error('Web reload mutated the terminal child sidecar');
        }
        if (
          !liveChildText.includes(input.childMarker) ||
          !/(completed|success)/i.test(liveChildText)
        ) {
          throw new Error(
            `Live child card was not terminal: ${JSON.stringify(liveChildText.slice(0, 1_000))}`
          );
        }
        if (
          !reloadedChildText.includes(input.childMarker) ||
          !/(completed|success)/i.test(reloadedChildText)
        ) {
          throw new Error(
            `Reloaded child card was not terminal: ${JSON.stringify(
              reloadedChildText.slice(0, 1_000)
            )}`
          );
        }
        await page.waitForTimeout(500);
        if (faults.length > 0) {
          throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
        }
        return {
          childSessionId,
          childVisible: true,
          parentVisible: true,
          noFakeUserMessage: true,
          providerAdmissionVisible: true,
          visibleAfterReload: true,
          sidecarStableAcrossReload: true,
          browserFaults: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const browserState = await page
          .evaluate(
            ({ marker }) => ({
              url: window.location.href,
              childCards: Array.from(
                document.querySelectorAll<HTMLElement>('[data-subagent-session-id]')
              ).map((element) => ({
                sessionId: element.dataset.subagentSessionId,
                text: element.textContent?.slice(0, 1_000),
              })),
              markerPresent: document.body.textContent?.includes(marker) ?? false,
              bodyTail: document.body.textContent?.slice(-4_000),
            }),
            { marker: input.childMarker }
          )
          .catch((stateError) => ({
            stateError:
              stateError instanceof Error ? stateError.message : String(stateError),
          }));
        throw new Error(
          `${message.replaceAll(input.secret, '[REDACTED]')}; browser=${JSON.stringify(
            browserState
          )
            .replaceAll(input.secret, '[REDACTED]')
            .slice(-8_000)}; server=${server.output
            .replaceAll(input.secret, '[REDACTED]')
            .slice(-2_000)}`
        );
      }
    }
  );
}
