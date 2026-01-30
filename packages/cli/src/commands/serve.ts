import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { networkOptions, resolveNetworkOptions } from '../cli/network.js';
import { BladeServer, getNetworkIPs } from '../server/index.js';
import { ensureStoreInitialized } from '../store/vanilla.js';

interface ServeArgs {
  port?: number;
  hostname?: string;
  cors?: string[];
}

export const serveCommand: CommandModule<object, ServeArgs> = {
  command: 'serve',
  describe: 'Start a headless Blade server (no browser)',
  builder: networkOptions,
  handler: async (args: ArgumentsCamelCase<ServeArgs>) => {
    const opts = resolveNetworkOptions(args);

    await ensureStoreInitialized();

    if (!process.env.BLADE_SERVER_PASSWORD) {
      console.log(chalk.yellow('Warning: BLADE_SERVER_PASSWORD is not set; server is unsecured.'));
    }

    const server = await BladeServer.listenAsync(opts);

    console.log(`Blade server listening on http://${server.hostname}:${server.port}`);

    if (opts.hostname === '0.0.0.0') {
      const networkIPs = getNetworkIPs();
      for (const ip of networkIPs) {
        console.log(`  Network: http://${ip}:${server.port}`);
      }
    }

    await new Promise(() => {
      // Keep the server running until process is terminated
    });
    await server.stop();
  },
};
