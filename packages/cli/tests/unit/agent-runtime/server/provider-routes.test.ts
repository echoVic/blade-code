import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRoutes } from '../../../../src/server/routes/provider.js';
import {
  installPiModelCatalogForTests,
  PiModelCatalog,
} from '../../../../src/services/pi/PiModelCatalog.js';

afterEach(() => {
  installPiModelCatalogForTests(undefined);
});

describe('ProviderRoutes', () => {
  it('serves pi-ai provider and model metadata', async () => {
    installPiModelCatalogForTests(new PiModelCatalog(new InMemoryCredentialStore()));
    const app = ProviderRoutes();

    const providers = (await (await app.request('/')).json()) as Array<{
      id: string;
      configured: boolean;
    }>;
    const models = (await (await app.request('/deepseek/models')).json()) as Array<{
      id: string;
      contextWindow: number;
    }>;

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'deepseek', configured: false }),
      ])
    );
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek-v4-pro',
          contextWindow: expect.any(Number),
        }),
      ])
    );
  });

  it('stores and clears credentials without returning the secret', async () => {
    installPiModelCatalogForTests(new PiModelCatalog(new InMemoryCredentialStore()));
    const app = ProviderRoutes();

    const saved = await app.request('/deepseek/credential', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'secret-value' }),
    });
    const providersAfterSave = JSON.stringify(await (await app.request('/')).json());
    const cleared = await app.request('/deepseek/credential', {
      method: 'DELETE',
    });

    expect(saved.status).toBe(200);
    expect(providersAfterSave).not.toContain('secret-value');
    expect(providersAfterSave).toContain('"configured":true');
    expect(cleared.status).toBe(200);
  });
});
