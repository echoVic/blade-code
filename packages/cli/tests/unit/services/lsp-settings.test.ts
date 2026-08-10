import { describe, expect, it } from 'vitest';
import { normalizeLspServers } from '../../../src/config/lspSettings.js';

describe('LSP settings normalization', () => {
  it('normalizes extensions and applies bounded lifecycle defaults', () => {
    expect(
      normalizeLspServers({
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          extensionToLanguage: {
            ts: 'typescript',
            '.TSX': 'typescriptreact',
          },
          env: { NODE_OPTIONS: '--max-old-space-size=2048' },
        },
      })
    ).toEqual({
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.tsx': 'typescriptreact',
        },
        env: { NODE_OPTIONS: '--max-old-space-size=2048' },
        priority: 0,
        startupTimeout: 10_000,
        shutdownTimeout: 2_000,
        requestTimeout: 10_000,
        diagnosticWaitTimeout: 750,
        maxRestarts: 3,
      },
    });
  });

  it.each([
    [
      { bad: { command: 'server', extensionToLanguage: {}, extra: true } },
      'Unknown LSP server field',
    ],
    [
      {
        bad: {
          command: 'server\nmalicious',
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
      'command must be a non-empty command',
    ],
    [
      {
        bad: {
          command: 'server',
          extensionToLanguage: { '../ts': 'typescript' },
        },
      },
      'Invalid lspServers.bad.extensionToLanguage',
    ],
    [
      {
        bad: {
          command: 'server',
          extensionToLanguage: { '.ts': 'typescript' },
          maxRestarts: 100,
        },
      },
      'maxRestarts must be an integer',
    ],
  ])('fails closed for malformed server config', (input, message) => {
    expect(() => normalizeLspServers(input)).toThrow(message);
  });
});
