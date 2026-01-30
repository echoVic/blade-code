import chalk from 'chalk';
import open from 'open';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { networkOptions, resolveNetworkOptions } from '../cli/network.js';
import { BladeServer, getNetworkIPs } from '../server/index.js';
import { ensureStoreInitialized } from '../store/vanilla.js';
import { getVersion } from '../utils/packageInfo.js';

const BLADE_LOGO = `
  ____  _           _      
 | __ )| | __ _  __| | ___ 
 |  _ \\| |/ _\` |/ _\` |/ _ \\
 | |_) | | (_| | (_| |  __/
 |____/|_|\\__,_|\\__,_|\\___|
`;

interface WebArgs {
  port?: number;
  hostname?: string;
  cors?: string[];
}

export const webCommand: CommandModule<object, WebArgs> = {
  command: 'web',
  describe: 'Start Blade server and open web interface',
  builder: networkOptions,
  handler: async (args: ArgumentsCamelCase<WebArgs>) => {
    const opts = resolveNetworkOptions(args);

    await ensureStoreInitialized();

    if (!process.env.BLADE_SERVER_PASSWORD) {
      console.log(chalk.yellow('⚠️  BLADE_SERVER_PASSWORD is not set; server is unsecured.'));
      console.log(chalk.gray('   Set this environment variable to enable Basic Auth.\n'));
    }

    const server = await BladeServer.listenAsync(opts);

    console.log(chalk.cyan(BLADE_LOGO));
    console.log(chalk.gray(`  v${getVersion()}\n`));

    if (opts.hostname === '0.0.0.0') {
      const localhostUrl = `http://localhost:${server.port}`;
      console.log(chalk.blue.bold('  Local access:      '), chalk.white(localhostUrl));

      const networkIPs = getNetworkIPs();
      for (const ip of networkIPs) {
        console.log(chalk.blue.bold('  Network access:    '), chalk.white(`http://${ip}:${server.port}`));
      }

      open(localhostUrl).catch(() => {
        // Ignore errors when opening browser
      });
    } else {
      const displayUrl = server.url.toString();
      console.log(chalk.blue.bold('  Web interface:     '), chalk.white(displayUrl));
      open(displayUrl).catch(() => {
        // Ignore errors when opening browser
      });
    }

    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop the server.\n'));

    await new Promise(() => {
      // Keep the server running until process is terminated
    });
    await server.stop();
  },
};
