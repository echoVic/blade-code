import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getState } from '../../../src/store/vanilla.js';
import { bashTool } from '../../../src/tools/builtin/shell/bash.js';
import { getCwd } from '../../../src/utils/cwd.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const qualification = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find(
      (model) => model.id === 'deepseek' && model.model === 'deepseek-v4-flash'
    )
  : undefined;
const describeReal = qualification ? describe.sequential : describe.skip;

async function git(workspace: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Blade Test',
      GIT_AUTHOR_EMAIL: 'blade@example.invalid',
      GIT_COMMITTER_NAME: 'Blade Test',
      GIT_COMMITTER_EMAIL: 'blade@example.invalid',
    },
  });
  return result.stdout;
}

describeReal('Fresh independent verification gate (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('blocks completion until a fresh verifier returns PASS', async () => {
    if (!qualification) {
      throw new Error('DeepSeek Flash qualification model is unavailable');
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-independent-verify-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const storage = path.join(root, 'storage');
    await mkdir(path.join(home, '.blade'), { recursive: true });
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await mkdir(path.join(workspace, 'test'), { recursive: true });
    await writeFile(
      path.join(workspace, 'package.json'),
      `${JSON.stringify(
        {
          name: 'blade-independent-verification-trajectory',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' },
        },
        null,
        2
      )}\n`
    );
    for (const name of ['alpha', 'beta', 'gamma']) {
      await writeFile(
        path.join(workspace, 'src', `${name}.js`),
        `export const ${name} = false;\n`
      );
    }
    await writeFile(
      path.join(workspace, 'test', 'values.test.js'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { alpha } from '../src/alpha.js';",
        "import { beta } from '../src/beta.js';",
        "import { gamma } from '../src/gamma.js';",
        '',
        "test('all values are enabled', () => {",
        '  assert.equal(alpha, true);',
        '  assert.equal(beta, true);',
        '  assert.equal(gamma, true);',
        '});',
        '',
      ].join('\n')
    );
    await git(workspace, ['init', '-q', '-b', 'main']);
    await git(workspace, ['add', '.']);
    await git(workspace, ['commit', '-qm', 'fixture']);
    const canonicalWorkspace = await realpath(workspace);

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    try {
      process.env.BLADE_STORAGE_ROOT = storage;
      setCwdState(canonicalWorkspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(qualification), null, 2)}\n`
      );
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      const sessionId = `real-independent-verification-${Date.now()}`;
      runtime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: canonicalWorkspace,
      });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['Read', 'ApplyPatch', 'Task'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 12,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'independent-verification-qualification',
        sessionId,
        workspaceRoot: canonicalWorkspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Read src/alpha.js, src/beta.js, and src/gamma.js.',
            'Then call ApplyPatch exactly once to change each exported value from',
            'false to true. Do not modify package.json or the test.',
            'After ApplyPatch succeeds, return exactly INDEPENDENT_VERIFY_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      const patchIndex = toolResults.findIndex(
        (event) => event.toolCall.function.name === 'ApplyPatch'
      );
      const verificationTaskResults = toolResults.filter(
        (event) => event.toolCall.function.name === 'Task'
      );
      const taskIndex = toolResults.findIndex(
        (event) => event.toolCall.function.name === 'Task'
      );
      const taskResult = verificationTaskResults.findLast(
        (event) => event.result.metadata?.verificationVerdict === 'pass'
      )?.result;
      const verifierEvent = events.findLast(
        (event) =>
          event.kind === 'subagent_completed' &&
          event.type === 'verification' &&
          event.verificationVerdict === 'pass'
      );
      const verifierSessions = runtime
        .listSubagents()
        .filter((session) => session.subagentType === 'verification');
      const passingVerifierSession = verifierSessions.findLast(
        (session) => session.result?.verificationVerdict === 'pass'
      );
      const diff = (await git(canonicalWorkspace, ['diff', '--name-only']))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const externalTest = await execFileAsync('npm', ['test'], {
        cwd: canonicalWorkspace,
        encoding: 'utf8',
      });
      const sandboxEscapeTarget = path.join(
        canonicalWorkspace,
        'verifier-sandbox-escape.txt'
      );
      const sandboxProbeScript = [
        "const fs = require('node:fs');",
        "const cp = require('node:child_process');",
        "const result = [process.env.DEEPSEEK_API_KEY ? 'secret' : 'clean'];",
        `try { fs.readFileSync(${JSON.stringify(path.join(home, '.blade', 'config.json'))}); result.push('read'); } catch { result.push('read-blocked'); }`,
        `try { fs.writeFileSync(${JSON.stringify(sandboxEscapeTarget)}, 'bad'); result.push('write'); } catch { result.push('write-blocked'); }`,
        "try { cp.execFileSync('curl', ['--max-time', '2', '-fsS', 'https://example.com']); result.push('network'); } catch { result.push('network-blocked'); }",
        "process.stdout.write(result.join(':'));",
      ].join(' ');
      const sandboxProbe = await bashTool.execute(
        {
          command: `node -e ${JSON.stringify(sandboxProbeScript)}`,
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          workspaceRoot: canonicalWorkspace,
          subagentType: 'verification',
        }
      );
      const evidence = JSON.stringify(
        {
          result,
          toolResults: toolResults.map((event) => ({
            name: event.toolCall.function.name,
            success: event.result.success,
            error: event.result.error,
            metadata: event.result.metadata,
          })),
          verifierEvent,
          verifierSessions,
        },
        null,
        2
      ).slice(-24_000);

      expect(result.success, evidence).toBe(true);
      expect(result.finalMessage).toMatch(/INDEPENDENT_VERIFY_REAL_OK|fresh.*PASS/is);
      expect(patchIndex).toBeGreaterThanOrEqual(0);
      expect(taskIndex).toBeGreaterThan(patchIndex);
      expect(taskResult).toMatchObject({
        success: true,
        metadata: {
          subagentType: 'verification',
          subagentStatus: 'completed',
          verificationAgentBuiltin: true,
          verificationVerdict: 'pass',
        },
      });
      expect(verifierEvent).toMatchObject({
        kind: 'subagent_completed',
        type: 'verification',
        success: true,
        verificationVerdict: 'pass',
      });
      expect(verifierSessions.length).toBeGreaterThanOrEqual(1);
      expect(passingVerifierSession).toMatchObject({
        status: 'completed',
        result: {
          success: true,
          verificationVerdict: 'pass',
          modifiedFiles: [],
        },
        configSnapshot: {
          source: 'builtin',
        },
      });
      expect(passingVerifierSession?.id).not.toBe(sessionId);
      expect(
        passingVerifierSession?.result?.verificationCommands?.length
      ).toBeGreaterThan(0);
      expect(diff).toEqual(['src/alpha.js', 'src/beta.js', 'src/gamma.js']);
      for (const name of ['alpha', 'beta', 'gamma']) {
        await expect(
          readFile(path.join(canonicalWorkspace, 'src', `${name}.js`), 'utf8')
        ).resolves.toBe(`export const ${name} = true;\n`);
      }
      expect(externalTest.stdout).toContain('pass');
      expect(sandboxProbe).toMatchObject({
        success: true,
        llmContent: {
          stdout: 'clean:read-blocked:write-blocked:network-blocked',
          exit_code: 0,
        },
        metadata: {
          sandboxed: true,
        },
      });
      await expect(readFile(sandboxEscapeTarget, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      assertNoSecrets({ result, events, verifierSessions }, [qualification.apiKey]);
    } finally {
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      homedirSpy.mockRestore();
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
