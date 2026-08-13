#!/usr/bin/env bun

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const INSTALL_COMMAND =
  'Install with: bun run --filter blade-code browser:install';

interface BrowserHandle {
  close(): Promise<void>;
}

export interface BrowserCheckOptions {
  executablePath?: string;
  access?: (path: string, mode: number) => Promise<void>;
  launch?: (options: {
    executablePath: string;
    headless: true;
  }) => Promise<BrowserHandle>;
}

export function resolveChromiumExecutablePath(): string {
  return chromium.executablePath();
}

export async function checkChromiumExecutable(
  options: BrowserCheckOptions = {}
): Promise<string> {
  const executablePath =
    options.executablePath ?? resolveChromiumExecutablePath();
  const checkAccess = options.access ?? access;
  const launch =
    options.launch ??
    ((launchOptions) =>
      chromium.launch({
        executablePath: launchOptions.executablePath,
        headless: launchOptions.headless,
      }));

  let browser: BrowserHandle | undefined;
  try {
    await checkAccess(executablePath, constants.X_OK);
    browser = await launch({ executablePath, headless: true });
    await browser.close();
    browser = undefined;
    return executablePath;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Chromium preflight failed: ${reason}\n${INSTALL_COMMAND}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    const executablePath = await checkChromiumExecutable();
    console.log(`Chromium preflight passed: ${executablePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
