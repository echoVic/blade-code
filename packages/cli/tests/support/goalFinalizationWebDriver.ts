import type { Page } from 'playwright';
import { waitForInboxRemoval } from './asyncTestUtils.js';
import { withBladeWebTest } from './bladeWebTestHarness.js';

export interface GoalFinalizationWebEvidence {
  initialVisible: true;
  completeGoalVisible: true;
  followupVisible: true;
  visibleAfterReload: true;
  browserFaults: [];
}

async function waitForCompleteGoal(input: {
  page: Page;
  origin: string;
  workspace: string;
  sessionId: string;
  timeoutMs: number;
  faults: readonly string[];
}): Promise<void> {
  const selector = '[data-blade-goal-status="complete"]';
  const deadline = Date.now() + input.timeoutMs;
  let persistedStatus: unknown = 'unknown';

  while (Date.now() < deadline) {
    const completeGoal = input.page.locator(selector);
    if ((await completeGoal.count()) > 0 && (await completeGoal.isVisible())) return;
    try {
      const response = await fetch(
        `${input.origin}/sessions/${encodeURIComponent(
          input.sessionId
        )}/goal?projectPath=${encodeURIComponent(input.workspace)}`
      );
      if (response.ok) {
        const body = (await response.json()) as {
          goal?: { status?: unknown } | null;
        };
        persistedStatus = body.goal?.status ?? null;
      } else {
        persistedStatus = `http-${response.status}`;
      }
    } catch (error) {
      persistedStatus = error instanceof Error ? error.message : String(error);
    }
    await input.page.waitForTimeout(100);
  }

  const domStatuses = await input.page
    .locator('[data-blade-goal-status]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-blade-goal-status'))
    );
  throw new Error(
    `Timed out waiting for complete Goal; persistedStatus=${String(
      persistedStatus
    )}; domStatuses=${JSON.stringify(domStatuses)}; browserFaults=${JSON.stringify(
      input.faults
    )}`
  );
}

export async function runGoalFinalizationWebDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  expectedInitial: string;
  followupPrompt: string;
  expectedFollowup: string;
  expectedFrontier: {
    taskListId: string;
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
    blocked: number;
  };
  secret: string;
  timeoutMs?: number;
}): Promise<GoalFinalizationWebEvidence> {
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
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        const initial = page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: input.expectedInitial })
          .last();
        await initial.waitFor({ state: 'visible', timeout: timeoutMs });
        await waitForCompleteGoal({
          page,
          origin,
          workspace: input.workspace,
          sessionId: input.sessionId,
          timeoutMs,
          faults,
        });
        await waitForGoalFrontier(page, input.expectedFrontier);
        await waitForInboxRemoval(input.workspace, input.sessionId, 10_000);
        if ((await page.locator('body').textContent())?.includes(input.secret)) {
          throw new Error('Provider credential reached the Goal finalization DOM');
        }

        await composer.fill(input.followupPrompt);
        await composer.press('Enter');
        const followup = page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: input.expectedFollowup })
          .last();
        await followup.waitFor({ state: 'visible', timeout: timeoutMs });

        state.refreshing = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        state.refreshing = false;
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        await initial.waitFor({ state: 'visible', timeout: 30_000 });
        await followup.waitFor({ state: 'visible', timeout: 30_000 });
        await waitForCompleteGoal({
          page,
          origin,
          workspace: input.workspace,
          sessionId: input.sessionId,
          timeoutMs,
          faults,
        });
        await waitForGoalFrontier(page, input.expectedFrontier);
        await page.waitForTimeout(500);
        if (faults.length > 0) {
          throw new Error(`Browser faults: ${JSON.stringify(faults)}`);
        }
        return {
          initialVisible: true,
          completeGoalVisible: true,
          followupVisible: true,
          visibleAfterReload: true,
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

async function waitForGoalFrontier(
  page: Page,
  expected: {
    taskListId: string;
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
    blocked: number;
  }
): Promise<void> {
  const section = page.locator('[data-blade-goal-frontier-task-list]').last();
  await section.waitFor({ state: 'visible', timeout: 30_000 });
  await section.evaluate((element, frontier) => {
    const attributes: Record<string, string | undefined> = {
      taskListId:
        element.getAttribute('data-blade-goal-frontier-task-list') ?? undefined,
      total: element.getAttribute('data-blade-goal-frontier-total') ?? undefined,
      completed:
        element.getAttribute('data-blade-goal-frontier-completed') ?? undefined,
      inProgress:
        element.getAttribute('data-blade-goal-frontier-in-progress') ?? undefined,
      pending: element.getAttribute('data-blade-goal-frontier-pending') ?? undefined,
      blocked: element.getAttribute('data-blade-goal-frontier-blocked') ?? undefined,
    };
    for (const [key, value] of Object.entries(frontier)) {
      if (attributes[key] !== String(value)) {
        throw new Error(
          `Goal frontier attribute ${key}=${String(attributes[key])} does not equal ${String(value)}`
        );
      }
    }
  }, expected);
}
