import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  assertForkLineage,
  assertForkChildToolTrace,
  assertForkParentToolTrace,
  assertNoSecrets,
  assertParentUnchanged,
  cleanupForkFixture,
  createForkFixture,
  type DurableToolTraceRecord,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
if (enabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error(
    'Runtime fork qualification requires DeepSeek credentials from the process environment'
  );
}
const modelConfigs = enabled
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true })
  : [];

function safeModelLabel(
  modelConfig: (typeof modelConfigs)[number],
  ordinal: number
): string {
  const digest = createHash('sha256')
    .update(modelConfig.model)
    .digest('hex')
    .slice(0, 12);
  return `${modelConfig.id}-${ordinal + 1}-${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolInput(
  event: Extract<LoopEvent, { kind: 'tool_start' }>
): Record<string, unknown> {
  if (!('function' in event.toolCall)) {
    throw new Error('Fork qualification requires a function tool call');
  }
  const parsed: unknown = JSON.parse(event.toolCall.function.arguments);
  if (!isRecord(parsed)) {
    throw new Error('Qualification tool arguments must be an object');
  }
  return parsed;
}

function extractLoopToolTrace(events: readonly LoopEvent[]): DurableToolTraceRecord[] {
  const orderedCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }> = [];
  const pending = new Map<string, (typeof orderedCalls)[number]>();
  const completed = new Map<
    string,
    Extract<LoopEvent, { kind: 'tool_result' }>['result']
  >();
  for (const event of events) {
    if (event.kind === 'tool_start') {
      if (!('function' in event.toolCall)) {
        throw new Error('Runtime tool trace requires function calls');
      }
      if (pending.has(event.toolCall.id) || completed.has(event.toolCall.id)) {
        throw new Error('Runtime tool trace contains a duplicate call');
      }
      const call = {
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.function.name,
        input: parseToolInput(event),
      };
      orderedCalls.push(call);
      pending.set(call.toolCallId, call);
    }
    if (event.kind === 'tool_result') {
      if (!('function' in event.toolCall)) {
        throw new Error('Runtime tool trace requires function calls');
      }
      if (completed.has(event.toolCall.id)) {
        throw new Error('Runtime tool trace contains a duplicate result');
      }
      const call = pending.get(event.toolCall.id);
      if (!call) throw new Error('Runtime tool trace contains an orphan result');
      if (call.toolName !== event.toolCall.function.name) {
        throw new Error('Runtime tool trace tool name mismatch');
      }
      pending.delete(event.toolCall.id);
      completed.set(event.toolCall.id, event.result);
    }
  }
  if (pending.size > 0) throw new Error('Runtime tool trace call is missing a result');
  return orderedCalls.map((call) => {
    const result = completed.get(call.toolCallId);
    if (!result) throw new Error('Runtime tool trace call is missing a result');
    return {
      ...call,
      output: result.success ? result.llmContent : null,
      error: result.success ? null : (result.error?.message ?? 'tool failed'),
    };
  });
}

function assertFinalContract(
  finalMessage: unknown,
  marker: string,
  nonce: string
): void {
  if (typeof finalMessage !== 'string' || finalMessage.trim().length === 0) {
    throw new Error('Qualification final response must be non-empty text');
  }
  if (finalMessage.includes(marker) || finalMessage.includes(nonce)) {
    throw new Error('Qualification final response exposed fixture material');
  }
}

function assertDurableParentTrace(
  events: readonly SessionEvent[],
  memoryPath: string
): void {
  assertForkParentToolTrace(extractDurableToolTrace(events), memoryPath);
}

function assertDurableChildTrace(
  events: readonly SessionEvent[],
  afterEventCount: number,
  resultPath: string,
  expectedBytes: string
): void {
  assertForkChildToolTrace(
    extractDurableToolTrace(events, { afterEventCount }),
    resultPath,
    expectedBytes
  );
}

function createResolvedConfig(
  modelConfig: (typeof modelConfigs)[number]
): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
  };
}

function initializeIsolatedExtensions(
  fixture: ReturnType<typeof createForkFixture>
): void {
  const userSkillsDir = path.join(fixture.storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(fixture.storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(fixture.workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(fixture.workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  for (const directory of [
    skillCreatorDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    path.join(skillCreatorDir, 'SKILL.md'),
    [
      '---',
      'name: skill-creator',
      'description: Isolated fixture skill used only to prevent network installation.',
      '---',
      '',
      '# Fixture Skill Creator',
      '',
      'This fixture is intentionally local and deterministic.',
      '',
    ].join('\n')
  );

  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: fixture.workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

async function releaseOwner(owner: {
  agent?: Agent;
  runtime?: SessionRuntime;
}): Promise<void> {
  const agent = owner.agent;
  const runtime = owner.runtime;
  owner.agent = undefined;
  owner.runtime = undefined;
  try {
    await agent?.destroy();
  } finally {
    await runtime?.dispose();
  }
}

async function proveLeaseReleased(
  sessionId: string,
  workspace: string,
  modelId: string
): Promise<void> {
  const replacement = await SessionRuntime.create({
    sessionId,
    workspaceRoot: workspace,
    modelId,
    mcpServers: {},
    agents: [],
  });
  await replacement.dispose();
}

const describeRuntimeTrajectory = enabled ? describe.sequential : describe.skip;

describeRuntimeTrajectory('Runtime durable fork trajectory (real API)', () => {
  if (modelConfigs.length === 0) {
    it('requires REAL_API_TEST=1', () => undefined);
  }
  for (const [modelIndex, modelConfig] of modelConfigs.entries()) {
    const modelLabel = safeModelLabel(modelConfig, modelIndex);
    it(`${modelLabel} forks inherited Read evidence into an independent Write/Bash child`, async () => {
      const fixture = createForkFixture('runtime', modelLabel);
      const marker = `RUNTIME_FORK_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const resultPath = path.join(fixture.workspace, 'result.txt');
      const parentId = `runtime-parent-${Date.now()}-${fixture.nonce.slice(-8)}`;
      const childId = `runtime-child-${Date.now()}-${fixture.nonce.slice(-8)}`;
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      const parentOwner: { agent?: Agent; runtime?: SessionRuntime } = {};
      const childOwner: { agent?: Agent; runtime?: SessionRuntime } = {};

      assertNoSecrets({ marker, expectedBytes, parentId, childId }, [
        modelConfig.apiKey,
      ]);

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        const runtimeConfig = createResolvedConfig(modelConfig);
        getState().config.actions.setConfig(runtimeConfig);
        writeFileSync(memoryPath, expectedBytes);

        await runWithCwdOverride(fixture.workspace, async () => {
          parentOwner.runtime = await SessionRuntime.create({
            sessionId: parentId,
            workspaceRoot: fixture.workspace,
            modelId: runtimeConfig.currentModelId,
            mcpServers: {},
            agents: [],
          });
          parentOwner.agent = await Agent.createWithRuntime(parentOwner.runtime, {
            sessionId: parentId,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
            toolWhitelist: ['Read'],
            maxTurns: 8,
            appendSystemPrompt: [
              'This is a deterministic fork qualification.',
              'Obey the requested tool sequence exactly and never repeat file contents in final prose.',
            ].join(' '),
          });
          const parentEvents: LoopEvent[] = [];
          const parentResult = await drainLoop(
            parentOwner.agent.chatStream(
              [
                'Use the Read tool exactly once to read the workspace file named memory.txt.',
                'Remember the complete file content for a later fork.',
                'Do not repeat, quote, encode, or summarize the file content in final prose.',
                'After the successful Read, give a brief completion confirmation.',
              ].join(' '),
              {
                messages: [],
                userId: 'runtime-fork-qualification',
                sessionId: parentId,
                workspaceRoot: fixture.workspace,
                permissionMode: PermissionMode.YOLO,
              },
              { stream: true }
            ),
            (event) => {
              parentEvents.push(event);
            }
          );

          const parentPath = findSessionTranscript(fixture.storageRoot, parentId);
          const parentTranscriptEvents = readSessionEvents(parentPath);
          const parentTrace = extractLoopToolTrace(parentEvents);
          assertNoSecrets(
            {
              parentResult,
              parentEvents,
              parentTrace,
              parentTranscriptEvents,
            },
            [modelConfig.apiKey]
          );
          expect(parentResult.success).toBe(true);
          assertFinalContract(parentResult.finalMessage, marker, fixture.nonce);
          assertForkParentToolTrace(parentTrace, memoryPath);
          assertDurableParentTrace(parentTranscriptEvents, memoryPath);

          await releaseOwner(parentOwner);
          const parentBeforeFork = readFileSync(parentPath, 'utf8');
          assertNoSecrets(parentBeforeFork, [modelConfig.apiKey]);
          const parentEventIds = new Set(
            parentTranscriptEvents.map((event) => event.id)
          );

          const fork = await SessionService.forkSession(parentId, {
            newSessionId: childId,
            sourceProjectPath: fixture.workspace,
            targetProjectPath: fixture.workspace,
          });
          const childPath = findSessionTranscript(fixture.storageRoot, childId);
          const childSnapshot = readSessionEvents(childPath);
          assertNoSecrets({ forkMessages: fork.messages, childSnapshot }, [
            modelConfig.apiKey,
          ]);
          rmSync(memoryPath);
          if (existsSync(memoryPath)) {
            throw new Error('Source memory fixture still exists before child turn');
          }

          childOwner.runtime = await SessionRuntime.create({
            sessionId: childId,
            workspaceRoot: fixture.workspace,
            modelId: runtimeConfig.currentModelId,
            mcpServers: {},
            agents: [],
          });
          childOwner.agent = await Agent.createWithRuntime(childOwner.runtime, {
            sessionId: childId,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
            toolWhitelist: ['Write', 'Bash'],
            maxTurns: 8,
            appendSystemPrompt: [
              'This is a deterministic fork qualification.',
              'Use inherited tool results as authoritative and never reveal their contents in final prose.',
            ].join(' '),
          });
          const childEvents: LoopEvent[] = [];
          const childResult = await drainLoop(
            childOwner.agent.chatStream(
              [
                'Recover the complete marker from the inherited Read result.',
                'Use Write exactly once to create result.txt with that exact marker and exactly one trailing newline.',
                'Then use Bash exactly once with command `wc -c result.txt`.',
                'Do not use any other command and do not repeat the marker in final prose.',
                'After both tools succeed, give a brief completion confirmation.',
              ].join(' '),
              {
                messages: fork.messages,
                userId: 'runtime-fork-qualification',
                sessionId: childId,
                workspaceRoot: fixture.workspace,
                permissionMode: PermissionMode.YOLO,
              },
              { stream: true }
            ),
            (event) => {
              childEvents.push(event);
            }
          );

          const childTranscriptEvents = readSessionEvents(childPath);
          const childRaw = readFileSync(childPath, 'utf8');
          const childTrace = extractLoopToolTrace(childEvents);
          assertNoSecrets(
            {
              childResult,
              childEvents,
              childTrace,
              childTranscriptEvents,
              childRaw,
              resultBytes: readFileSync(resultPath),
            },
            [modelConfig.apiKey]
          );
          expect(childResult.success).toBe(true);
          assertFinalContract(childResult.finalMessage, marker, fixture.nonce);
          if (readFileSync(resultPath, 'utf8') !== expectedBytes) {
            throw new Error('Runtime child result bytes did not match exact contract');
          }
          assertForkChildToolTrace(childTrace, resultPath, expectedBytes);
          assertDurableChildTrace(
            childTranscriptEvents,
            childSnapshot.length,
            resultPath,
            expectedBytes
          );
          assertParentUnchanged(parentBeforeFork, parentPath);
          assertForkLineage(childTranscriptEvents, {
            childId,
            parentId,
            rootId: parentId,
          });
          expect(childTranscriptEvents.length).toBeGreaterThan(childSnapshot.length);
          expect(
            childTranscriptEvents.every((event) => !parentEventIds.has(event.id))
          ).toBe(true);

          await releaseOwner(childOwner);
          await proveLeaseReleased(
            parentId,
            fixture.workspace,
            runtimeConfig.currentModelId
          );
          await proveLeaseReleased(
            childId,
            fixture.workspace,
            runtimeConfig.currentModelId
          );
        });
      } finally {
        await runWithCwdOverride(fixture.workspace, async () => {
          await releaseOwner(childOwner).catch(() => undefined);
          await releaseOwner(parentOwner).catch(() => undefined);
        });
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        cleanupForkFixture(fixture);
      }
    }, 360_000);
  }
});
