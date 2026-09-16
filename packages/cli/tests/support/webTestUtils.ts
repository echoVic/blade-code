import type { Page } from 'playwright';

export interface BrowserRequestFailure {
  url: string;
  resourceType: string;
  errorText: string;
  refreshing: boolean;
  closing: boolean;
}

export function isExpectedBrowserRequestFailure(
  failure: BrowserRequestFailure
): boolean {
  if (failure.closing) return true;
  const aborted = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure.errorText);
  if (!aborted) return false;
  if (new URL(failure.url).pathname.endsWith('/events')) return true;
  return failure.refreshing && failure.resourceType === 'document';
}

export function observeBrowserFaults(
  page: Page,
  faults: string[],
  state: () => Pick<BrowserRequestFailure, 'refreshing' | 'closing'>,
  includeHttpErrors = true
): void {
  page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(`console:${message.text()}`);
  });
  if (includeHttpErrors) {
    page.on('response', (response) => {
      if (response.status() >= 400) {
        faults.push(`http:${response.status()}:${response.url()}`);
      }
    });
  }
  page.on('requestfailed', (request) => {
    const failure = {
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? 'unknown',
      ...state(),
    };
    if (!isExpectedBrowserRequestFailure(failure)) {
      faults.push(`requestfailed:${failure.errorText}:${failure.url}`);
    }
  });
}

export async function ensureYoloMode(page: Page): Promise<void> {
  const permissionMode = page.locator('[data-blade-permission-mode]');
  await permissionMode.waitFor({ state: 'visible' });
  if ((await permissionMode.getAttribute('data-blade-permission-mode')) === 'yolo') {
    return;
  }
  await permissionMode.click();
  await page.locator('[data-blade-permission-option="yolo"]').click();
  await page.locator('[data-blade-yolo-confirm]').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-blade-permission-mode]')
        ?.getAttribute('data-blade-permission-mode') === 'yolo'
  );
}
