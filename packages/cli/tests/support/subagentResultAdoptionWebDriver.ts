import { waitForInboxRemoval } from './asyncTestUtils.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';

export interface SubagentResultAdoptionWebEvidence {
  childVisible: true;
  parentVisible: true;
  visibleAfterReload: true;
  browserFaults: [];
}

export async function runSubagentResultAdoptionWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  childSessionId: string;
  childMarker: string;
  parentResponse: string;
  secret: string;
  timeoutMs?: number;
}): Promise<SubagentResultAdoptionWebEvidence> {
  const configuredTimeout = Number(process.env.BLADE_SUBAGENT_ADOPTION_WEB_TIMEOUT_MS);
  const timeoutMs =
    input.timeoutMs ??
    (Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 180_000);
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
        const childCard = page
          .locator(`[data-subagent-session-id="${input.childSessionId}"]`)
          .filter({ hasText: input.childMarker });
        const parentMessage = page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: input.parentResponse })
          .last();
        await childCard.waitFor({ state: 'visible', timeout: timeoutMs });
        await parentMessage.waitFor({ state: 'visible', timeout: timeoutMs });
        await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
        if ((await page.locator('body').textContent())?.includes(input.secret)) {
          throw new Error('Provider credential reached the adoption DOM');
        }

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await childCard.waitFor({ state: 'visible', timeout: 30_000 });
        await parentMessage.waitFor({ state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(500);
        if (faults.length > 0) {
          throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
        }
        return {
          childVisible: true,
          parentVisible: true,
          visibleAfterReload: true,
          browserFaults: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const browserState = await page
          .evaluate(
            ({ childSessionId, childMarker, parentResponse }) => ({
              url: window.location.href,
              targetChildPresent:
                document.querySelector(
                  `[data-subagent-session-id="${CSS.escape(childSessionId)}"]`
                ) !== null,
              childMarkerPresent:
                document.body.textContent?.includes(childMarker) ?? false,
              parentResponsePresent:
                document.body.textContent?.includes(parentResponse) ?? false,
              subagents: Array.from(
                document.querySelectorAll<HTMLElement>('[data-subagent-id]')
              ).map((element) => ({
                id: element.dataset.subagentId,
                sessionId: element.dataset.subagentSessionId,
                text: element.textContent?.slice(0, 1_000),
              })),
              bodyTail: document.body.textContent?.slice(-4_000),
            }),
            {
              childSessionId: input.childSessionId,
              childMarker: input.childMarker,
              parentResponse: input.parentResponse,
            }
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
