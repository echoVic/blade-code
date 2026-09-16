import type { Page } from 'playwright';
import { SessionSchema } from '../../src/api/schemas.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';
import { createTuiTaskAttentionSecretScanner } from './tuiTaskAttentionPtyDriver.js';

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_?KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

export interface FollowUpQueueWebEvidence {
  success: true;
  panelOpened: true;
  reordered: true;
  deleted: true;
  reloadPreservedOrder: true;
  retainedMessagesPromoted: true;
  deletedMessageAbsent: true;
  finalMarkerSeen: true;
  cleanupComplete: true;
  browserFaults: string[];
  serverFaults: string[];
  leakedSecrets: string[];
}

async function submit(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.fill(text);
  await page.locator('[data-blade-submit]').click();
}

async function queueTexts(page: Page): Promise<string[]> {
  return page
    .locator('[data-blade-follow-up-queue] [data-follow-up-id]')
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
}

async function openQueue(page: Page): Promise<void> {
  const panel = page.locator('[data-blade-follow-up-queue]');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const toggle = panel.getByRole('button', { name: /Show follow-up queue/ });
  if ((await toggle.count()) > 0) await toggle.click();
}

function inspectServerFaults(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /\b(error|panic|fatal)\b/i.test(line))
    .slice(-20);
}

export async function runFollowUpQueueWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  primaryPrompt: string;
  firstMarker: string;
  deletedMarker: string;
  movedMarker: string;
  expectedOutput: string;
  providerApiKey: string;
  secrets: readonly string[];
  waitForProviderHold(): Promise<void>;
  releaseProvider(): void;
  timeoutMs?: number;
}): Promise<FollowUpQueueWebEvidence> {
  const timeoutMs = input.timeoutMs ?? 240_000;
  const serverSecretScanner = createTuiTaskAttentionSecretScanner(input.secrets);
  return withBladeWebTest(
    {
      ...input,
      baseEnv: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && !CREDENTIAL_ENV_NAME.test(entry[0])
        )
      ),
      env: { BLADE_API_KEY: input.providerApiKey },
      outputLimit: 32_000,
      onOutput: (chunk) => serverSecretScanner.observe(chunk),
    },
    { context: { locale: 'en-US' } },
    async ({ server, origin, page, faults, state }) => {
      let released = false;
      try {
        const created = await fetch(`${origin}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: input.workspace,
            title: 'Follow-up queue qualification',
          }),
        });
        if (!created.ok)
          throw new Error(`Create Session failed with ${created.status}`);
        const session = SessionSchema.parse(await created.json());

        const navigation = new URL(origin);
        navigation.searchParams.set('session', session.sessionId);
        navigation.searchParams.set('project', input.workspace);
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });

        await submit(page, input.primaryPrompt);
        await input.waitForProviderHold();
        const followUps = [input.firstMarker, input.deletedMarker, input.movedMarker];
        for (const [index, marker] of followUps.entries()) {
          await submit(page, marker);
          await waitFor(
            async () =>
              (
                await page!.locator('[data-blade-follow-up-queue]').textContent()
              )?.includes(`${index + 1} queued`) === true,
            `Web did not enqueue ${marker}`,
            15_000
          );
        }
        await openQueue(page);
        await waitFor(
          async () => (await queueTexts(page!)).length === 3,
          'Web queue panel did not render three rows',
          15_000
        );
        const movedRow = page.locator('[data-follow-up-id]', {
          hasText: input.movedMarker,
        });
        await movedRow.getByRole('button', { name: /Move .* up/ }).click();
        await waitFor(
          async () => {
            const texts = await queueTexts(page!);
            return (
              texts[0]?.includes(input.firstMarker) === true &&
              texts[1]?.includes(input.movedMarker) === true &&
              texts[2]?.includes(input.deletedMarker) === true
            );
          },
          'Web queue move did not commit A, C, B',
          15_000
        );
        const deletedRow = page.locator('[data-follow-up-id]', {
          hasText: input.deletedMarker,
        });
        await deletedRow.getByRole('button', { name: /Remove follow-up/ }).click();
        await waitFor(
          async () => (await queueTexts(page!)).length === 2,
          'Web queue delete did not commit',
          15_000
        );

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        await openQueue(page);
        await waitFor(
          async () => {
            const texts = await queueTexts(page!);
            return (
              texts.length === 2 &&
              texts[0]?.includes(input.firstMarker) === true &&
              texts[1]?.includes(input.movedMarker) === true
            );
          },
          'Web reload did not preserve A, C order',
          30_000
        );

        input.releaseProvider();
        released = true;
        await page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: input.expectedOutput })
          .last()
          .waitFor({ state: 'visible', timeout: timeoutMs });
        await waitFor(
          async () => {
            const users = await page!
              .locator('[data-chat-role="user"]')
              .allTextContents();
            return (
              users.filter((text) => text.includes(input.firstMarker)).length === 1 &&
              users.filter((text) => text.includes(input.movedMarker)).length === 1 &&
              users.every((text) => !text.includes(input.deletedMarker))
            );
          },
          'Web did not promote retained queue rows exactly once',
          30_000
        );
        await page.waitForTimeout(500);

        const browserText = (await page.locator('body').textContent()) ?? '';
        const serverFaults = inspectServerFaults(server.output);
        const leakSources = [browserText, server.output, JSON.stringify(faults)];
        const leakedSecrets = [
          ...new Set([
            ...serverSecretScanner.leakedSecretLabels(),
            ...input.secrets.flatMap((secret, index) =>
              secret && leakSources.some((source) => source.includes(secret))
                ? [`secret-${index + 1}`]
                : []
            ),
          ]),
        ];
        if (faults.length > 0)
          throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
        if (serverFaults.length > 0) {
          throw new Error(`Server faults: ${JSON.stringify(serverFaults)}`);
        }
        if (leakedSecrets.length > 0)
          throw new Error('Web evidence exposed credentials');
        return {
          success: true,
          panelOpened: true,
          reordered: true,
          deleted: true,
          reloadPreservedOrder: true,
          retainedMessagesPromoted: true,
          deletedMessageAbsent: true,
          finalMarkerSeen: true,
          cleanupComplete: true,
          browserFaults: [],
          serverFaults: [],
          leakedSecrets: [],
        };
      } finally {
        if (!released) input.releaseProvider();
      }
    }
  );
}
