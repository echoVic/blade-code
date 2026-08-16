import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');
vi.unmock('child_process');

import {
  AcpServiceContext,
  getAcpFileSystemService,
  getTerminalService,
} from '../../../../src/acp/AcpServiceContext.js';
import { ControlledTerminalClient } from '../../../support/acp/ControlledTerminalClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

const capabilities: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

describe('AcpServiceContext session isolation', () => {
  const harnesses: PairedAcpHarness[] = [];

  afterEach(async () => {
    AcpServiceContext.destroySession('session-a');
    AcpServiceContext.destroySession('session-b');
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('resolves file and terminal services by session through paired SDK connections', async () => {
    const clientA = new ControlledTerminalClient();
    const clientB = new ControlledTerminalClient();
    const harnessA = createPairedAcpHarness(clientA);
    const harnessB = createPairedAcpHarness(clientB);
    harnesses.push(harnessA, harnessB);
    clientA.enqueueOutput({ output: 'a:session-a:/workspace/a', truncated: false });
    clientA.enqueueOutput({ output: 'a:session-a:/workspace/a', truncated: false });
    clientA.resolveWait({ exitCode: 0 });

    AcpServiceContext.initializeSession(
      harnessA.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );
    AcpServiceContext.initializeSession(
      harnessB.agentConnection,
      'session-b',
      capabilities,
      '/workspace/b'
    );
    AcpServiceContext.setCurrentSession('session-b');

    await expect(
      getAcpFileSystemService('session-a').readTextFile('/workspace/a/file.ts')
    ).resolves.toBe('controlled:session-a:/workspace/a/file.ts');
    await expect(
      getAcpFileSystemService('session-b').readTextFile('/workspace/b/file.ts')
    ).resolves.toBe('controlled:session-b:/workspace/b/file.ts');

    await expect(
      getTerminalService('session-a').execute('git status', { cwd: '/workspace/a' })
    ).resolves.toMatchObject({
      success: true,
      stdout: 'a:session-a:/workspace/a',
      transport: 'acp',
    });
    expect(clientA.createRequests).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        cwd: '/workspace/a',
      }),
    ]);
  });

  it('binds a local terminal to the Session cwd when capability is absent', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-local-session-'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      directory
    );

    const marker = join(directory, 'marker');
    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify("require('node:fs').writeFileSync('marker', 'ok')"),
    ].join(' ');
    try {
      await expect(
        getTerminalService('session-a').execute(command)
      ).resolves.toMatchObject({
        success: true,
        transport: 'local',
      });
      await expect(access(marker)).resolves.toBeUndefined();
      expect(client.createRequests).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes cumulative ACP output reads and exposes a merged bounded capture', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const outputChunks: string[] = [];
    const firstRead = client.enqueueBlockedOutput({ output: 'a', truncated: false });
    client.enqueueOutput({ output: 'ab', truncated: false });
    client.resolveWait({ exitCode: 0 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf ab', {
      onOutput: (output) => outputChunks.push(output),
    });
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(client.outputRequests).toHaveLength(1);
    expect(client.maxConcurrentOutputReads).toBe(1);
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(2));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      success: true,
      stdout: 'ab',
      stderr: '',
      transport: 'acp',
      capture: {
        terminalOutputMerged: true,
        stdout: { accountingComplete: true },
        stderr: { content: '', totalBytes: 0 },
      },
    });
    expect(client.maxConcurrentOutputReads).toBe(1);
    expect(outputChunks.join('')).toBe('ab');
  }, 5000);

  it('fails closed when local execution is pre-aborted', async () => {
    AcpServiceContext.destroySession('session-a');
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-pre-abort-'));
    const marker = join(directory, 'marker');
    const controller = new AbortController();
    controller.abort();
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(program),
    ].join(' ');

    try {
      await expect(
        getTerminalService().execute(command, { signal: controller.signal })
      ).resolves.toMatchObject({
        failureKind: 'aborted',
        transport: 'local',
        error: 'Command was terminated',
      });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves nonzero ACP output without classifying a terminal failure', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'nonzero-output',
      truncated: false,
    });
    client.enqueueOutput({ output: 'nonzero-output', truncated: false });
    client.resolveWait({ exitCode: 7 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('exit 7');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();

    const result = await execution;
    expect(result).toMatchObject({
      success: false,
      stdout: 'nonzero-output',
      exitCode: 7,
      transport: 'acp',
    });
    expect(result.failureKind).toBeUndefined();
  });

  it('rebuilds a complete final capture after poll output regresses', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'abcdef',
      truncated: false,
    });
    client.enqueueOutput({ output: 'abc', truncated: false });
    client.enqueueOutput({ output: 'complete', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf complete');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(2));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'complete',
      transport: 'acp',
      capture: {
        stdout: { totalBytes: 8, accountingComplete: true },
      },
    });
  });

  it('marks capture accounting incomplete when final ACP output is truncated', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'tail', truncated: true });
    client.enqueueOutput({ output: 'tail', truncated: true });
    client.resolveWait({ exitCode: 0 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('printf tail')
    ).resolves.toMatchObject({
      stdout: 'tail',
      stderr: '',
      capture: {
        terminalOutputMerged: true,
        stdout: { accountingComplete: false },
        stderr: { accountingComplete: false },
      },
    });
  });

  it('restores complete accounting when a failed poll is followed by a complete final read', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutputError(new Error('poll failed'));
    client.enqueueOutput({ output: 'recovered', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf recovered');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(1));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'recovered',
      capture: { stdout: { accountingComplete: true } },
    });
  });

  it('keeps the lower-bound poll capture when final ACP output read fails', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'lower-bound',
      truncated: false,
    });
    client.enqueueOutputError(new Error('final read failed'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf lower-bound');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(1));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'lower-bound',
      capture: {
        stdout: { accountingComplete: false },
      },
    });
  });

  it('awaits kill, final output, and release before resolving timeout', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'after-kill', truncated: false });
    client.enqueueOutput({ output: 'after-kill', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('sleep 10', { timeout: 1 })
    ).resolves.toMatchObject({
      success: false,
      stdout: 'after-kill',
      error: 'Command timed out',
      failureKind: 'timeout',
      transport: 'acp',
    });
    expect(client.callOrder).toContain('kill');
    expect(client.callOrder).toContain('release');
    expect(client.callOrder.indexOf('kill')).toBeLessThan(
      client.callOrder.lastIndexOf('output')
    );
    expect(client.callOrder.lastIndexOf('output')).toBeLessThan(
      client.callOrder.indexOf('release')
    );
  });

  it('does not let a stalled ACP output read defeat terminal timeout cleanup', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const blocked = client.enqueueBlockedOutput({
      output: 'never-returned',
      truncated: false,
    });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('sleep 10', {
      timeout: 1,
    });

    await expect(execution).resolves.toMatchObject({
      success: false,
      stdout: '',
      failureKind: 'timeout',
      transport: 'acp',
      capture: {
        stdout: { accountingComplete: false },
      },
    });
    expect(client.killRequests).toHaveLength(1);
    expect(client.releaseRequests).toHaveLength(1);
    expect(client.maxConcurrentOutputReads).toBe(1);
    blocked.release();
  }, 10_000);

  it('does not classify a slow bounded ACP output response as stalled', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'slow-complete-output',
      truncated: false,
    });
    client.enqueueOutput({
      output: 'slow-complete-output',
      truncated: false,
    });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf slow');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    firstRead.release();
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      success: true,
      stdout: 'slow-complete-output',
      capture: {
        stdout: { accountingComplete: true },
      },
    });
    expect(client.maxConcurrentOutputReads).toBe(1);
  }, 10_000);

  it('awaits kill, final output, and release before resolving an abort', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'after-abort', truncated: false });
    client.enqueueOutput({ output: 'after-abort', truncated: false });
    const controller = new AbortController();
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('sleep 10', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      success: false,
      stdout: 'after-abort',
      error: 'Command was aborted',
      failureKind: 'aborted',
      transport: 'acp',
    });
    expect(client.callOrder.indexOf('kill')).toBeLessThan(
      client.callOrder.lastIndexOf('output')
    );
    expect(client.callOrder.lastIndexOf('output')).toBeLessThan(
      client.callOrder.indexOf('release')
    );
  });

  it('fails closed when ACP terminal creation fails without an explicit fallback opt-in', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.failCreate(new Error('offline'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('printf local')
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^ACP terminal unavailable:/),
      failureKind: 'unavailable',
      transport: 'acp',
    });
  });

  it('uses local fallback only with explicit opt-in and labels its transport', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.failCreate(new Error('offline'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify("process.stdout.write('local-fallback')"),
    ].join(' ');
    await expect(
      getTerminalService('session-a').execute(command, {
        allowLocalFallback: true,
      })
    ).resolves.toMatchObject({
      success: true,
      stdout: 'local-fallback',
      transport: 'local_fallback',
    });
  });

  it('bounds local split output and classifies timeout and abort separately', async () => {
    AcpServiceContext.destroySession('session-a');
    const service = getTerminalService();
    const oversized = 1024 * 1024 + 64;
    const outputProgram =
      `process.stdout.write('o'.repeat(${oversized}));` +
      `process.stderr.write('e'.repeat(${oversized}))`;
    const foreverProgram = 'setInterval(() => {}, 1_000)';
    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(outputProgram),
    ].join(' ');
    const forever = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(foreverProgram),
    ].join(' ');

    await expect(service.execute(command)).resolves.toMatchObject({
      success: true,
      transport: 'local',
      capture: {
        terminalOutputMerged: false,
        stdout: { totalBytes: oversized, omittedBytes: 64 },
        stderr: { totalBytes: oversized, omittedBytes: 64 },
      },
    });
    await expect(service.execute(forever, { timeout: 1 })).resolves.toMatchObject({
      success: false,
      error: 'Command was terminated',
      failureKind: 'timeout',
      transport: 'local',
    });
    const controller = new AbortController();
    const aborted = service.execute(forever, { signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({
      success: false,
      error: 'Command was terminated',
      failureKind: 'aborted',
      transport: 'local',
    });
  });
});
