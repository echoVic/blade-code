import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function functionBody(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('foreground command handoff source gate', () => {
  it('never restarts the local command during handoff', () => {
    const bash = source('../../src/tools/builtin/shell/bash.ts');
    const body = functionBody(
      bash,
      'async function executeWithForegroundHandoff(',
      '/**\n * 使用 ACP 终端服务执行命令'
    );

    expect(body.match(/startForegroundCandidate\(/g)).toHaveLength(1);
    expect(body).not.toContain('startBackgroundProcess(');
    expect(body).not.toContain('spawn(');
    expect(body).not.toContain('exec(');
  });

  it('commits the next lease before removing foreground ownership', () => {
    const durable = source('../../src/context/storage/DurableForegroundProcess.ts');
    const body = functionBody(
      durable,
      'handoff(registerNextOwner, rollbackNextOwner)',
      'finalize()'
    );

    expect(body.indexOf('registerNextOwner')).toBeLessThan(
      body.indexOf('leaseStore?.remove')
    );
    expect(body.indexOf('leaseStore?.remove')).toBeLessThan(
      body.indexOf('handedOff = true')
    );
    expect(body).toContain('rollbackNextOwner()');
  });

  it('publishes local visibility only after durable handoff', () => {
    const manager = source('../../src/tools/builtin/shell/BackgroundShellManager.ts');
    const body = functionBody(
      manager,
      'promoteForegroundCandidate(',
      'waitForCompletion('
    );

    expect(body.indexOf('processInfo.foreground.handoff(')).toBeLessThan(
      body.indexOf('processInfo.visible = true')
    );
  });

  it('keeps production limits finite and rejects test-only bypasses', () => {
    const manager = source('../../src/tools/builtin/shell/BackgroundShellManager.ts');
    const config = source('../../src/config/foregroundCommandHandoff.ts');
    const combined = `${manager}\n${config}`;

    expect(combined).not.toContain('Number.POSITIVE_INFINITY');
    expect(combined).not.toMatch(/\bInfinity\b/);
    expect(combined).not.toMatch(/NODE_ENV\s*===\s*['"]test['"]/);
    expect(combined).not.toMatch(/BLADE_TEST/);
  });

  it('requires sticky raw PTY completion evidence in the release trajectory', () => {
    const runner = source('../support/foregroundCommandHandoffPtyRunner.ts');
    const trajectory = source(
      '../integration/real-api/foreground-command-handoff-trajectory.test.ts'
    );
    const fixture = source('../support/foregroundCommandHandoffFixtureDriver.ts');

    expect(runner).toContain('finalMarkerSeen: finalMarkerLatch.seen');
    expect(runner).toContain('secretSeen: secretLatch.seen');
    expect(fixture).toContain('createSplitPtyMarkerInstruction');
    expect(fixture).toContain('assertSplitPtyMarkerInstructionAtEnd(prompt, marker)');
    expect(fixture.indexOf('Do not call any other tool')).toBeLessThan(
      fixture.lastIndexOf('createSplitPtyMarkerInstruction')
    );
    expect(fixture).toContain('finalAssistantText(events) !== input.fixture.marker');
    expect(fixture).toContain(
      'Foreground handoff Session did not persist its exact final authority'
    );
    expect(fixture).not.toContain(
      "events.filter((event) => event.type === 'turn_completed').length === 1"
    );
    expect(trajectory).toContain('!isCompleteRawPtyMarkerEvidence(parsed)');
  });
});
