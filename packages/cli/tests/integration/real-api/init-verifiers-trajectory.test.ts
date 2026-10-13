import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { resetWorkspaceAgentResources } from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { verificationAgentConfig } from '../../../src/agent/subagents/builtinVerificationAgent.js';
import { SubagentExecutor } from '../../../src/agent/subagents/SubagentExecutor.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { loadSkillMetadata } from '../../../src/skills/SkillLoader.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { INIT_VERIFIERS_PROMPT } from '../../../src/slash-commands/initVerifiers.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const describeReal = isRealApiTestEnabled() ? describe : describe.skip;

describeReal(
  '/init-verifiers generation and independent consumption (real API)',
  () => {
    it('generates a valid project skill and a fresh verifier reads and runs it', async () => {
      const [model] = resolveRequiredDeepSeekQualificationModels();
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-init-verifiers-'));
      const workspace = path.join(root, 'workspace');
      const previousCwd = getCwd();
      const previousConfig = getState().config.config;
      const previousStorage = process.env.BLADE_STORAGE_ROOT;
      let runtime: SessionRuntime | undefined;
      let freshRuntime: SessionRuntime | undefined;
      let agent: Agent | undefined;
      try {
        await mkdir(path.join(workspace, '.blade'), { recursive: true });
        await writeFile(
          path.join(workspace, 'package.json'),
          JSON.stringify({
            name: 'verifier-fixture',
            private: true,
            scripts: { test: 'node --test sample.test.mjs' },
          })
        );
        await writeFile(
          path.join(workspace, 'sample.test.mjs'),
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sum', () => assert.equal(1 + 1, 2));\n"
        );
        process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
        setCwdState(workspace);
        ConfigManager.resetInstance();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        const config = {
          ...buildRealApiRuntimeConfig(model),
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        };
        await writeFile(
          path.join(workspace, '.blade', 'config.json'),
          JSON.stringify({
            models: config.models,
            currentModelId: config.currentModelId,
          })
        );
        SkillRegistry.getInstance({
          cwd: workspace,
          userSkillsDir: path.join(root, 'user-skills'),
          claudeUserSkillsDir: path.join(root, 'claude-skills'),
        });
        await WorkspaceTrustService.getInstance().trust(workspace);
        getState().config.actions.setConfig(config);
        runtime = await SessionRuntime.create({
          workspaceRoot: workspace,
          sessionId: `generate-verifiers-${Date.now()}`,
        });
        agent = await Agent.createWithRuntime(runtime, {
          sessionId: runtime.sessionId,
          toolWhitelist: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
          maxTurns: 16,
        });
        const generated = await drainLoop(
          agent.chatStream(
            INIT_VERIFIERS_PROMPT,
            {
              messages: [],
              userId: 'qualification',
              sessionId: runtime.sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { stream: true }
          )
        );
        expect(generated.success).toBe(true);
        const skillRoot = path.join(workspace, '.blade', 'skills');
        const names = (await readdir(skillRoot)).filter((name) =>
          name.startsWith('verify-')
        );
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          const parsed = await loadSkillMetadata(
            path.join(skillRoot, name, 'SKILL.md'),
            'project'
          );
          expect(parsed.success).toBe(true);
          expect(parsed.content?.metadata.name).toBe(name);
          expect(parsed.content?.metadata.userInvocable).toBe(true);
        }

        await WorkspaceTrustService.getInstance().trust(workspace);
        resetWorkspaceAgentResources();
        freshRuntime = await SessionRuntime.create({
          workspaceRoot: workspace,
          sessionId: `consume-verifiers-${Date.now()}`,
        });
        const events: LoopEvent[] = [];
        const verifier = new SubagentExecutor(
          { ...verificationAgentConfig, maxTurns: 12 },
          freshRuntime.getAgentResources()
        );
        const verified = await verifier.execute({
          prompt:
            'Verify this small project. Read the applicable project verification skill and run its test command. No implementation changes are needed.',
          workspaceRoot: workspace,
          parentSessionId: freshRuntime.sessionId,
          permissionMode: PermissionMode.YOLO,
          onEvent: (event) => {
            events.push(event);
          },
        });
        expect(verified.success).toBe(true);
        expect(verified.verificationVerdict).toBe('pass');
        expect(verified.verificationCommands?.length).toBeGreaterThan(0);
        const reads = events.flatMap((event) =>
          event.kind === 'tool_start' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'Read'
            ? [event.toolCall.function.arguments]
            : []
        );
        expect(reads.some((arguments_) => arguments_.includes('SKILL.md'))).toBe(true);
        console.log(
          `[init-verifiers] ${JSON.stringify({
            model: model.model,
            generatedSkills: names,
            verdict: verified.verificationVerdict,
            verificationCommands: verified.verificationCommands,
          })}`
        );
      } finally {
        await agent?.destroy();
        await runtime?.dispose();
        await freshRuntime?.dispose();
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        ConfigManager.resetInstance();
        setCwdState(previousCwd);
        if (previousConfig) getState().config.actions.setConfig(previousConfig);
        if (previousStorage === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorage;
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);
  }
);
