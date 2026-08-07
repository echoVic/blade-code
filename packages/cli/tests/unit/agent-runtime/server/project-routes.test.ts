import { describe, expect, it, vi } from 'vitest';
import {
  isLocalDirectoryPickerOrigin,
  ProjectRoutes,
} from '../../../../src/server/routes/projects.js';

describe('ProjectRoutes folder picker', () => {
  it('accepts local browser and desktop origins only', () => {
    expect(isLocalDirectoryPickerOrigin('http://localhost:5174')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('http://127.0.0.1:4097')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('http://[::1]:4097')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('tauri://localhost')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('https://blade.example.com')).toBe(false);
    expect(isLocalDirectoryPickerOrigin(undefined)).toBe(false);
    expect(isLocalDirectoryPickerOrigin('not a URL')).toBe(false);
  });

  it('returns a selected folder without binding it inside the picker route', async () => {
    const pickDirectory = vi.fn(async () => ({
      cancelled: false as const,
      path: '/tmp/project',
    }));
    const app = ProjectRoutes({ pickDirectory });

    const response = await app.request('/pick', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5174' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelled: false,
      path: '/tmp/project',
    });
    expect(pickDirectory).toHaveBeenCalledOnce();
  });

  it('does not invoke the native picker for a remote origin', async () => {
    const pickDirectory = vi.fn(async () => ({ cancelled: true as const }));
    const app = ProjectRoutes({ pickDirectory });
    app.onError((error, context) => {
      const status =
        'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      return context.json({ error: error.message }, status as 403 | 500);
    });

    const response = await app.request('/pick', {
      method: 'POST',
      headers: { Origin: 'https://blade.example.com' },
    });

    expect(response.status).toBe(403);
    expect(pickDirectory).not.toHaveBeenCalled();
  });
});
