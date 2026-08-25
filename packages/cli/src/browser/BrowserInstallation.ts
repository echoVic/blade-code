import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export const BROWSER_INSTALL_COMMAND = 'blade browser install';
export const BROWSER_NOT_INSTALLED_CODE = 'browser_not_installed';

const RUNTIME_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'XDG_RUNTIME_DIR',
] as const;

const INSTALL_ENVIRONMENT_KEYS = [
  ...RUNTIME_ENVIRONMENT_KEYS,
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT',
  'PLAYWRIGHT_DOWNLOAD_HOST',
  'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

const MAX_ENVIRONMENT_VALUE_CHARS = 32 * 1024;
const MAX_ERROR_CHARS = 4 * 1024;

interface BrowserHandle {
  close(): Promise<void>;
  version(): string;
}

interface ChromiumHandle {
  executablePath(): string;
  launch(options: {
    executablePath: string;
    headless: true;
    chromiumSandbox: true;
    env: Record<string, string>;
  }): Promise<BrowserHandle>;
}

interface PlaywrightModule {
  chromium: ChromiumHandle;
}

interface ChildProcessHandle {
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
}

export interface BrowserInstallationStatus {
  playwrightVersion: string;
  executablePath: string;
  installed: boolean;
  browserVersion?: string;
  error?: string;
}

export interface BrowserInstallationOptions {
  environment?: NodeJS.ProcessEnv;
  execPath?: string;
  access?: (filePath: string, mode: number) => Promise<void>;
  loadPlaywright?: () => Promise<PlaywrightModule>;
  resolvePackageJson?: () => string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      shell: false;
      stdio: 'inherit';
    }
  ) => ChildProcessHandle;
}

export class BrowserInstallationError extends Error {
  readonly code = BROWSER_NOT_INSTALLED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'BrowserInstallationError';
  }
}

function copyEnvironment(
  source: NodeJS.ProcessEnv,
  keys: readonly string[]
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value.length <= MAX_ENVIRONMENT_VALUE_CHARS) {
      result[key] = value;
    }
  }
  return result;
}

export function createBrowserRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return copyEnvironment(source, RUNTIME_ENVIRONMENT_KEYS) as Record<string, string>;
}

export function createBrowserInstallerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return copyEnvironment(source, INSTALL_ENVIRONMENT_KEYS);
}

export function resolvePlaywrightPackageJson(): string {
  return createRequire(import.meta.url).resolve('playwright/package.json');
}

export function resolvePlaywrightCli(
  resolvePackageJson: () => string = resolvePlaywrightPackageJson
): string {
  return path.join(path.dirname(resolvePackageJson()), 'cli.js');
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  return (await import('playwright')) as PlaywrightModule;
}

async function readPlaywrightVersion(packageJsonPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('Playwright package version is invalid');
  }
  return parsed.version;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_CHARS);
}

export async function getBrowserInstallationStatus(
  options: BrowserInstallationOptions = {}
): Promise<BrowserInstallationStatus> {
  const resolvePackageJson = options.resolvePackageJson ?? resolvePlaywrightPackageJson;
  const packageJsonPath = resolvePackageJson();
  const playwrightVersion = await readPlaywrightVersion(packageJsonPath);
  const playwright = await (options.loadPlaywright ?? loadPlaywright)();
  const executablePath = playwright.chromium.executablePath();
  const checkAccess = options.access ?? access;
  let browser: BrowserHandle | undefined;

  try {
    await checkAccess(executablePath, constants.X_OK);
    browser = await playwright.chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: true,
      env: createBrowserRuntimeEnvironment(options.environment),
    });
    const browserVersion = browser.version();
    await browser.close();
    browser = undefined;
    return {
      playwrightVersion,
      executablePath,
      installed: true,
      browserVersion,
    };
  } catch (error) {
    return {
      playwrightVersion,
      executablePath,
      installed: false,
      error: sanitizeError(error),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function requireBrowserInstallation(
  options: BrowserInstallationOptions = {}
): Promise<BrowserInstallationStatus & { installed: true; browserVersion: string }> {
  const status = await getBrowserInstallationStatus(options);
  if (!status.installed || !status.browserVersion) {
    throw new BrowserInstallationError(
      `Chromium preflight failed: ${status.error ?? 'executable unavailable'}\n` +
        `Install with: ${BROWSER_INSTALL_COMMAND}`
    );
  }
  return {
    ...status,
    installed: true,
    browserVersion: status.browserVersion,
  };
}

export async function installBrowser(
  options: BrowserInstallationOptions = {}
): Promise<void> {
  const resolvePackageJson = options.resolvePackageJson ?? resolvePlaywrightPackageJson;
  const cliPath = resolvePlaywrightCli(resolvePackageJson);
  const spawnProcess =
    options.spawn ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as ChildProcessHandle);

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(
      options.execPath ?? process.execPath,
      [cliPath, 'install', 'chromium'],
      {
        env: createBrowserInstallerEnvironment(options.environment),
        shell: false,
        stdio: 'inherit',
      }
    );
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Playwright browser installer stopped by ${signal}`
            : `Playwright browser installer exited with code ${code ?? 1}`
        )
      );
    });
  });
}
