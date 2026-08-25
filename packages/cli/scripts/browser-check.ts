#!/usr/bin/env bun

import {
  type BrowserInstallationOptions,
  requireBrowserInstallation,
} from '../src/browser/BrowserInstallation.js';

export type BrowserCheckOptions = BrowserInstallationOptions;

export async function checkChromiumExecutable(
  options: BrowserCheckOptions = {}
): Promise<string> {
  return (await requireBrowserInstallation(options)).executablePath;
}

if (import.meta.main) {
  try {
    const status = await requireBrowserInstallation();
    console.log(
      `Chromium preflight passed: Playwright ${status.playwrightVersion}, ` +
        `Chromium ${status.browserVersion}, ${status.executablePath}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
