import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('foreground Provider recovery source gate', () => {
  it('keeps extended recovery owned by root Agent requests', () => {
    const loop = source('../../src/agent/loop/executeLoopGenerator.ts');

    expect(loop).toContain(
      '!isSubagent && (deps.config.providerForegroundRecoveryMs ?? 0) > 0'
    );
    expect(loop).toContain("mode: 'bounded_foreground' as const");
    expect(loop).toContain('providerRecovery: foregroundProviderRecovery');
  });

  it('never serializes recovery control metadata into pi-ai options', () => {
    const options = source('../../src/services/pi/requestOptions.ts');

    expect(options).not.toContain('providerRecovery');
    expect(options).toContain('maxRetries: 0');
  });

  it('keeps retry count and deadline finite without a test bypass', () => {
    const recovery = source('../../src/config/foregroundProviderRecovery.ts');
    const service = source('../../src/services/PiAIChatService.ts');
    const combined = `${recovery}\n${service}`;

    expect(combined).not.toContain('Number.POSITIVE_INFINITY');
    expect(combined).not.toMatch(/\bInfinity\b/);
    expect(combined).not.toMatch(/NODE_ENV\s*===\s*['"]test['"]/);
    expect(combined).not.toMatch(/BLADE_TEST/);
    expect(recovery).toContain('DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES = 12');
    expect(recovery).toContain('DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS = 600_000');
  });

  it('owns one hard timer per retry stream and clears it on every exit', () => {
    const service = source('../../src/services/PiAIChatService.ts');

    expect(service.match(/budgetTimer = setTimeout/g)).toHaveLength(1);
    expect(service).toContain('budgetTimer.unref?.()');
    expect(service).toContain('if (budgetTimer) clearTimeout(budgetTimer)');
  });

  it('keeps the first real chunk as the replay commit boundary', () => {
    const service = source('../../src/services/PiAIChatService.ts');

    expect(service).toContain('if (emitted) {');
    expect(service).toContain('markProviderReplayBoundary(error)');
    expect(service).toContain('onRealChunk();');
  });

  it('requires sticky raw PTY completion evidence in the release trajectory', () => {
    const runner = source('../support/foregroundProviderRecoveryPtyRunner.ts');
    const trajectory = source(
      '../integration/real-api/foreground-provider-recovery-trajectory.test.ts'
    );

    expect(runner).toContain('finalMarkerSeen: finalMarkerLatch.seen');
    expect(runner).toContain('secretSeen: secretLatch.seen');
    expect(runner).not.toContain('recoveryBoundary');
    expect(trajectory).toContain('createSplitPtyMarkerInstruction');
    expect(trajectory).toContain(
      'const secondaryPrompt = createSplitPtyMarkerInstruction(secondaryMarker)'
    );
    expect(trajectory).toContain(
      'Secondary Provider recovery marker contaminated the prompt'
    );
    expect(trajectory).toContain(
      'finalAssistantText(readSessionEvents(secondaryTranscriptPath)) ==='
    );
    expect(trajectory).toContain(
      'expect(finalAssistantText(secondaryEvents)).toBe(secondaryMarker)'
    );
    const acpRunner = source('../support/foregroundProviderRecoveryAcpRunner.ts');
    expect(acpRunner).toContain(
      'finalAssistantText(readSessionEvents(secondaryTranscriptPath)) !=='
    );
    expect(trajectory).not.toContain('Reply with exactly ${secondaryMarker}');
    expect(trajectory).not.toContain(
      'secondaryTranscript.includes(input.secondaryMarker)'
    );
    expect(acpRunner).not.toContain(
      'secondaryTranscript.includes(input.secondaryMarker)'
    );
    expect(trajectory).toContain('!isCompleteRawPtyMarkerEvidence(parsed)');
    const ptyBranch = trajectory.indexOf(
      "envName: 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT'"
    );
    const ptyTimeout = trajectory.indexOf('timeoutMs: 480_000', ptyBranch);
    const webBranch = trajectory.indexOf('} else {', ptyBranch);
    expect(ptyBranch).toBeGreaterThanOrEqual(0);
    expect(ptyTimeout).toBeGreaterThan(ptyBranch);
    expect(ptyTimeout).toBeLessThan(webBranch);
    expect(trajectory).toContain('540_000');
  });
});
