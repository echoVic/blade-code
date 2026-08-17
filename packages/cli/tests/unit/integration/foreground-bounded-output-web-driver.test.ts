import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');
vi.unmock('child_process');

import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  isTerminalForegroundWebRunStatus,
  parseForegroundGuiReadyLine,
  stopForegroundGuiLauncher,
  waitForForegroundGuiLauncherReady,
} from '../../support/foregroundBoundedOutputWebDriver.js';

describe('foreground bounded output Web driver', () => {
  it('atomically reopens remounted tool groups by durable call identity', () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../support/foregroundBoundedOutputWebDriver.ts'
      ),
      'utf8'
    );

    expect(source).toContain('expectedToolCallId');
    expect(source).toContain('groupToggle.click()');
    expect(source).toContain('toggle.click()');
    expect(source).not.toContain("const toggle = card.locator('[data-tool-call-id]');");
  });

  it('classifies only terminal Web run states as terminal', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
      expect(isTerminalForegroundWebRunStatus(status)).toBe(true);
    }
    for (const status of ['idle', 'queued', 'running', 'waiting_permission']) {
      expect(isTerminalForegroundWebRunStatus(status)).toBe(false);
    }
  });

  it('accepts only a safe minimal launcher ready record', () => {
    expect(parseForegroundGuiReadyLine('{"ready":true,"port":4312}')).toEqual({
      ready: true,
      port: 4312,
    });
    expect(
      parseForegroundGuiReadyLine(
        '{"home":"/private/home","storage":"/private/storage","port":4312}'
      )
    ).toBeUndefined();
    expect(parseForegroundGuiReadyLine('not-json')).toBeUndefined();
  });

  it('allows only navigation or EventSource aborts during an explicit refresh', () => {
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/',
        resourceType: 'document',
        errorText: 'net::ERR_ABORTED',
        refreshing: true,
        closing: false,
      })
    ).toBe(true);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_ABORTED',
        refreshing: true,
        closing: false,
      })
    ).toBe(true);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/api/messages',
        resourceType: 'fetch',
        errorText: 'net::ERR_FAILED',
        refreshing: true,
        closing: false,
      })
    ).toBe(false);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_ABORTED',
        refreshing: false,
        closing: false,
      })
    ).toBe(true);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_FAILED',
        refreshing: false,
        closing: false,
      })
    ).toBe(false);
  });

  it('allows request failures once driver cleanup begins', () => {
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_FAILED',
        refreshing: false,
        closing: true,
      })
    ).toBe(true);
  });

  it('retries launcher identity capture and fails closed without an identity', async () => {
    const identity = {
      platform: 'darwin' as const,
      fingerprint: 'a'.repeat(64),
    };
    let attempts = 0;

    await expect(
      captureForegroundGuiLauncherIdentity(42, {
        timeoutMs: 50,
        retryMs: 1,
        capture: () => {
          attempts += 1;
          return attempts === 3 ? identity : undefined;
        },
      })
    ).resolves.toEqual(identity);
    expect(attempts).toBe(3);

    await expect(
      captureForegroundGuiLauncherIdentity(42, {
        timeoutMs: 0,
        capture: () => undefined,
      })
    ).rejects.toThrow('Unable to capture GUI launcher process identity');
  });

  it('bounds pre-ready output and keeps draining after the ready record', async () => {
    const script = [
      "process.stdout.write('n'.repeat(256 * 1024) + '\\n');",
      `process.stdout.write('${JSON.stringify({ ready: true, port: 4312 })}\\n');`,
      "process.stdout.write('x'.repeat(256 * 1024));",
      "process.stdout.write('DRAIN_COMPLETE\\n');",
    ].join('');
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stopDrain: (() => void) | undefined;

    try {
      const ready = await waitForForegroundGuiLauncherReady(child, 2_000, []);
      stopDrain = ready.stopDrain;
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('launcher stdout was not drained')), 2_000)
        ),
      ]);
      expect(ready.output()).toContain('DRAIN_COMPLETE');
      expect(ready.output().length).toBeLessThanOrEqual(16_384);
    } finally {
      stopDrain?.();
      await stopForegroundGuiLauncher(child, undefined);
    }
  });

  it('terminates an unidentified launcher instead of skipping cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    await stopForegroundGuiLauncher(child, undefined);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
