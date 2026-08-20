import { afterEach, describe, expect, it } from 'vitest';
import { taskRunScheduler } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import { GlobalRoutes } from '../../../../src/server/routes/global.js';

describe('GlobalRoutes task admission control', () => {
  afterEach(() => {
    taskRunScheduler.resetForTests();
  });

  it('pauses and resumes automatic task admission', async () => {
    const app = GlobalRoutes();

    const pauseResponse = await app.request('/task-admission', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    expect(pauseResponse.status).toBe(200);
    await expect(pauseResponse.json()).resolves.toMatchObject({
      paused: true,
      inFlight: 0,
      queued: 0,
    });

    const infoResponse = await app.request('/info');
    expect(infoResponse.status).toBe(200);
    await expect(infoResponse.json()).resolves.toMatchObject({
      taskAdmission: {
        paused: true,
      },
    });

    const resumeResponse = await app.request('/task-admission', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    await expect(resumeResponse.json()).resolves.toMatchObject({
      paused: false,
    });
  });
});
