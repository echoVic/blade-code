import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Goal finalization Web driver source contract', () => {
  it('centralizes production Web server and browser ownership', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../support/bladeWebTestHarness.ts'),
      'utf8'
    );

    expect(source).toContain('../../dist/blade.js');
    expect(source).toContain('chromium.launch({ headless: true })');
    expect(source).toContain('stopForegroundGuiLauncher');
    expect(source).toContain('waitForHttp(`${origin}/health`');
  });

  it('uses the configured evidence budget and persisted Goal diagnostics', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../support/goalFinalizationWebDriver.ts'),
      'utf8'
    );

    expect(source).toContain('async function waitForCompleteGoal');
    expect(source).toContain('/goal?projectPath=');
    expect(source).toContain('persistedStatus=');
    expect(source).not.toContain(
      `.locator('[data-blade-goal-status="complete"]')\n      .waitFor({ state: 'visible', timeout: 30_000 })`
    );
  });
});
