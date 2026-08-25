import type { CommandModule } from 'yargs';
import {
  BROWSER_INSTALL_COMMAND,
  getBrowserInstallationStatus,
  installBrowser,
} from '../browser/BrowserInstallation.js';

export const browserStatusCommand: CommandModule = {
  command: 'status',
  describe: 'Check the pinned Playwright Chromium installation',
  handler: async () => {
    const status = await getBrowserInstallationStatus();
    console.log(`Playwright: ${status.playwrightVersion}`);
    console.log(`Chromium executable: ${status.executablePath}`);
    if (!status.installed) {
      console.error(`Chromium: unavailable (${status.error ?? 'unknown error'})`);
      console.error(`Install with: ${BROWSER_INSTALL_COMMAND}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Chromium: ${status.browserVersion}`);
    console.log('Status: ready');
  },
};

export const browserInstallCommand: CommandModule = {
  command: 'install',
  describe: 'Install Chromium for the pinned Playwright runtime',
  handler: async () => {
    try {
      await installBrowser();
      const status = await getBrowserInstallationStatus();
      if (!status.installed) {
        throw new Error(status.error ?? 'Chromium is not runnable after installation');
      }
      console.log(
        `Chromium installed: Playwright ${status.playwrightVersion}, ` +
          `${status.browserVersion}`
      );
    } catch (error) {
      console.error(
        `Browser installation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exitCode = 1;
    }
  },
};

export const browserCommands: CommandModule = {
  command: 'browser',
  describe: 'Manage the native Browser Tool runtime',
  builder: (yargs) =>
    yargs
      .command(browserStatusCommand)
      .command(browserInstallCommand)
      .demandCommand(1)
      .strict(),
  handler: () => undefined,
};
