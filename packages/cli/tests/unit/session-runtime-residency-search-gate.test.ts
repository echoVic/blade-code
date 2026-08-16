import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = path.resolve(import.meta.dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(path.join(cliRoot, relativePath), 'utf8');
}

describe('Session Runtime residency source gate', () => {
  it('reserves Web capacity before constructing a Session Runtime', () => {
    const sessionRoutes = source('src/server/routes/session.ts');
    const reservation = sessionRoutes.indexOf('runtimeResidency.reserve(key');
    const runtimeCreate = sessionRoutes.indexOf('SessionRuntime.create({');

    expect(reservation).toBeGreaterThan(0);
    expect(runtimeCreate).toBeGreaterThan(reservation);
    expect(sessionRoutes).not.toContain('getOrCreateRuntime');
    expect(sessionRoutes).toContain('runtimeLease?.release()');
    expect(sessionRoutes).toContain('runtime.isIdleForResidency()');
  });

  it('reserves ACP capacity before task, Runtime, or Session construction', () => {
    const bladeAgent = source('src/acp/BladeAgent.ts');
    const reservationHelper = bladeAgent.indexOf(
      'private async reserveSessionRuntime('
    );
    const managerReservation = bladeAgent.indexOf(
      'this.runtimeResidency.reserve(sessionId',
      reservationHelper
    );
    const newSessionStart = bladeAgent.indexOf('async newSession(');
    const newSessionReservation = bladeAgent.indexOf(
      'this.reserveSessionRuntime(sessionId)',
      newSessionStart
    );
    const durableTask = bladeAgent.indexOf(
      'SessionTaskService.createSessionTask',
      newSessionStart
    );
    const sessionCreate = bladeAgent.indexOf('new AcpSession(', newSessionStart);
    const forkStart = bladeAgent.indexOf('async unstable_forkSession(');
    const forkReservation = bladeAgent.indexOf(
      'this.reserveSessionRuntime(forkSessionId)',
      forkStart
    );
    const durableFork = bladeAgent.indexOf('SessionService.forkSession', forkStart);
    const replaceStart = bladeAgent.indexOf('private async replaceSession(');
    const loadReservation = bladeAgent.indexOf(
      'this.reserveSessionRuntime(params.sessionId)',
      replaceStart
    );
    const durableLoad = bladeAgent.indexOf(
      'SessionService.loadSession(params.sessionId',
      replaceStart
    );

    expect(managerReservation).toBeGreaterThan(reservationHelper);
    expect(newSessionReservation).toBeGreaterThan(newSessionStart);
    expect(durableTask).toBeGreaterThan(newSessionReservation);
    expect(sessionCreate).toBeGreaterThan(newSessionReservation);
    expect(forkReservation).toBeGreaterThan(forkStart);
    expect(durableFork).toBeGreaterThan(forkReservation);
    expect(loadReservation).toBeGreaterThan(replaceStart);
    expect(durableLoad).toBeGreaterThan(loadReservation);
    expect(bladeAgent.match(/this\.runtimeResidency\.reserve\(/g)).toHaveLength(1);
    expect(bladeAgent.match(/this\.sessions\.set\(/g)).toHaveLength(1);
  });

  it('advertises standard ACP close and drains exact Session ownership', () => {
    const bladeAgent = source('src/acp/BladeAgent.ts');

    expect(bladeAgent).toContain('close: {}');
    expect(bladeAgent).toContain('async closeSession(');
    expect(bladeAgent).toContain('this.closeResidentSession(params.sessionId)');
    expect(bladeAgent).toContain('discardPendingInput: true');
    expect(bladeAgent).toContain('await this.runtimeResidency.disposeAll()');
  });

  it('keeps the Web idle sweeper bounded and shutdown-owned', () => {
    const sessionRoutes = source('src/server/routes/session.ts');

    expect(sessionRoutes).toContain('runtimeSweepTimer.unref?.()');
    expect(sessionRoutes).toContain('clearInterval(runtimeSweepTimer)');
    expect(sessionRoutes).toContain('await settle([runtimeResidency.disposeAll()])');
    expect(sessionRoutes).not.toMatch(/residentSessionIds|residentKeys|lruOrder/);
  });

  it('does not allow zero or Infinity to disable the process boundary', () => {
    const config = source('src/config/sessionRuntimeResidency.ts');
    const manager = source('src/agent/runtime/SessionRuntimeResidency.ts');

    expect(config).toContain('MIN_RESIDENT_SESSION_RUNTIMES = 1');
    expect(config).toContain('MIN_SESSION_RUNTIME_IDLE_MS = 30_000');
    expect(config).not.toContain('Infinity');
    expect(manager).not.toContain('Infinity');
  });
});
