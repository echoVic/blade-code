import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRealApiCredentialEnvironment,
  materializeRealApiEnvironment,
  REAL_API_CREDENTIAL_FILE_ENV,
} from '../../../scripts/real-api-credentials.js';

const temporaryRoots: string[] = [];

function createCredentialFile(contents: unknown, mode = 0o600): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-credentials-'));
  temporaryRoots.push(root);
  const filePath = path.join(root, 'credentials.json');
  writeFileSync(filePath, `${JSON.stringify(contents)}\n`, { mode });
  chmodSync(filePath, mode);
  return filePath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real API credential file', () => {
  it('projects a secure provider matrix into the legacy environment contract', () => {
    const filePath = createCredentialFile({
      version: 1,
      providers: {
        deepseek: {
          apiKey: 'deepseek-secret',
          baseURL: 'https://deepseek.invalid/v1',
          models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        },
        claude: {
          apiKey: 'claude-secret',
          baseURL: 'https://gateway.invalid/v1',
          model: 'claude-test',
        },
        gpt: {
          apiKey: 'gpt-secret',
          baseURL: 'https://gateway.invalid',
          model: 'gpt-test',
        },
        domestic: {
          apiKey: 'domestic-secret',
          baseURL: 'https://gateway.invalid',
          model: 'domestic-test',
        },
      },
    });

    expect(
      loadRealApiCredentialEnvironment({
        [REAL_API_CREDENTIAL_FILE_ENV]: filePath,
      })
    ).toEqual({
      DEEPSEEK_API_KEY: 'deepseek-secret',
      DEEPSEEK_BASE_URL: 'https://deepseek.invalid/v1',
      DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      CLAUDE_API_KEY: 'claude-secret',
      CLAUDE_BASE_URL: 'https://gateway.invalid/v1',
      CLAUDE_MODEL: 'claude-test',
      GPT_API_KEY: 'gpt-secret',
      GPT_BASE_URL: 'https://gateway.invalid',
      GPT_MODEL: 'gpt-test',
      DOMESTIC_API_KEY: 'domestic-secret',
      DOMESTIC_BASE_URL: 'https://gateway.invalid',
      DOMESTIC_MODEL: 'domestic-test',
    });
  });

  it('keeps explicitly supplied environment values authoritative', () => {
    const filePath = createCredentialFile({
      version: 1,
      providers: {
        claude: {
          apiKey: 'file-secret',
          model: 'file-model',
        },
      },
    });

    expect(
      materializeRealApiEnvironment({
        [REAL_API_CREDENTIAL_FILE_ENV]: filePath,
        CLAUDE_API_KEY: 'environment-secret',
        CLAUDE_MODEL: 'environment-model',
      })
    ).toMatchObject({
      CLAUDE_API_KEY: 'environment-secret',
      CLAUDE_MODEL: 'environment-model',
    });
  });

  it('does not merge the default credential file into an inline allowlist', () => {
    expect(
      loadRealApiCredentialEnvironment({
        CLAUDE_API_KEY: 'inline-secret',
      })
    ).toEqual({});
  });

  it('fails closed for an explicitly configured missing file', () => {
    expect(() =>
      loadRealApiCredentialEnvironment({
        [REAL_API_CREDENTIAL_FILE_ENV]: path.join(
          os.tmpdir(),
          'blade-missing-real-api-credentials.json'
        ),
      })
    ).toThrow('does not exist');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects credentials readable by group or other users',
    () => {
      const filePath = createCredentialFile(
        {
          version: 1,
          providers: {
            claude: { apiKey: 'must-not-appear-in-error' },
          },
        },
        0o644
      );

      expect(() =>
        loadRealApiCredentialEnvironment({
          [REAL_API_CREDENTIAL_FILE_ENV]: filePath,
        })
      ).toThrow('permissions must be 0600');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic links even when their target is private',
    () => {
      const target = createCredentialFile({
        version: 1,
        providers: {
          claude: { apiKey: 'must-not-appear-in-error' },
        },
      });
      const link = path.join(path.dirname(target), 'credentials-link.json');
      symlinkSync(target, link);

      expect(() =>
        loadRealApiCredentialEnvironment({
          [REAL_API_CREDENTIAL_FILE_ENV]: link,
        })
      ).toThrow('regular file');
    }
  );

  it('rejects unsupported schema fields without echoing credential values', () => {
    const secret = 'schema-secret-must-not-leak';
    const filePath = createCredentialFile({
      version: 1,
      providers: {
        claude: {
          apiKey: secret,
          unsupported: true,
        },
      },
    });

    let message = '';
    try {
      loadRealApiCredentialEnvironment({
        [REAL_API_CREDENTIAL_FILE_ENV]: filePath,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('unsupported fields');
    expect(message).not.toContain(secret);
  });
});
