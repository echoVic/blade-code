import type { Options } from 'yargs';

export interface NetworkOptions {
  port: number;
  hostname: string;
  cors: string[];
}

export const networkOptions: Record<string, Options> = {
  port: {
    type: 'number',
    describe: 'Port to listen on (0 for auto)',
    default: 0,
  },
  hostname: {
    type: 'string',
    describe: 'Hostname to listen on',
    default: '127.0.0.1',
  },
  cors: {
    type: 'array',
    describe: 'Additional domains to allow for CORS',
    default: [] as string[],
  },
};

export function resolveNetworkOptions(args: Partial<NetworkOptions>): NetworkOptions {
  return {
    port: args.port ?? 0,
    hostname: args.hostname ?? '127.0.0.1',
    cors: (args.cors ?? []) as string[],
  };
}
