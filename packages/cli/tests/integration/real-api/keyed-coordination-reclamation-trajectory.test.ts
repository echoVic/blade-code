import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { OAuthTokenStorage } from '../../../src/mcp/auth/OAuthTokenStorage.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { BladeServer } from '../../../src/server/server.js';
import { sessionInteractionCoordinationStatsForTests } from '../../../src/services/SessionInteractionService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { findSessionTranscript } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];

interface TestServer {
  url: string | URL;
  stop(): Promise<void>;
}

interface AcpHarness {
  connection: acp.ClientSideConnection;
  agent: BladeAgent;
  close(): Promise<void>;
}

class RecordingAcpClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

function runtimeConfig(model: TestModelConfig): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(model);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    allowedTools: [],
    disallowedTools: [],
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpEnabled: false,
    mcpServers: {},
    maxResidentSessionRuntimes: 4,
    sessionRuntimeIdleMs: 30_000,
  };
}

async function initializeIsolatedExtensions(
  workspace: string,
  storageRoot: string
): Promise<void> {
  const userSkillsDir = path.join(storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  await Promise.all(
    [
      skillCreatorDir,
      claudeUserSkillsDir,
      projectSkillsDir,
      claudeProjectSkillsDir,
    ].map((directory) => mkdir(directory, { recursive: true }))
  );
  await writeFile(
    path.join(skillCreatorDir, 'SKILL.md'),
    [
      '---',
      'name: skill-creator',
      'description: Local qualification fixture',
      '---',
      '',
      'No network installation is required.',
      '',
    ].join('\n')
  );

  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
}

function endpoint(server: TestServer, pathname: string): URL {
  return new URL(pathname.replace(/^\//, ''), server.url);
}

async function createWebSession(
  server: TestServer,
  workspace: string,
  title: string
): Promise<string> {
  const response = await fetch(endpoint(server, '/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: workspace, title }),
  });
  if (!response.ok) {
    throw new Error(`Web Session creation failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as { sessionId?: unknown };
  if (typeof result.sessionId !== 'string') {
    throw new Error('Web Session creation returned no Session ID');
  }
  return result.sessionId;
}

async function deleteWebSession(
  server: TestServer,
  workspace: string,
  sessionId: string
): Promise<void> {
  const url = endpoint(server, `/sessions/${sessionId}`);
  url.searchParams.set('projectPath', workspace);
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Web Session deletion failed with HTTP ${response.status}`);
  }
}

async function waitForWebSessionTerminal(
  server: TestServer,
  workspace: string,
  sessionId: string
): Promise<void> {
  await waitFor(async () => {
    const url = endpoint(server, `/sessions/${sessionId}/status`);
    url.searchParams.set('projectPath', workspace);
    const response = await fetch(url);
    if (!response.ok) return false;
    const status = (await response.json()) as { status?: unknown };
    return (
      status.status === 'idle' ||
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'cancelled'
    );
  }, `Web Session ${sessionId} did not settle`);
}

async function openWebSession(
  page: Page,
  server: TestServer,
  workspace: string,
  sessionId: string
) {
  const url = new URL(server.url);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('project', workspace);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(
    async () => !(await composer.isDisabled()),
    'Web composer did not become ready',
    30_000
  );
  return composer;
}

async function selectYolo(page: Page): Promise<void> {
  const permissionMode = page.locator('[data-blade-permission-mode]');
  if ((await permissionMode.getAttribute('data-blade-permission-mode')) === 'yolo') {
    return;
  }
  await permissionMode.click();
  await page.locator('[data-blade-permission-option="yolo"]').click();
  await page.locator('[data-blade-yolo-confirm]').click();
}

async function submitWebMessage(
  page: Page,
  sessionId: string,
  content: string
): Promise<void> {
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.fill(content);
  const submit = page.locator('[data-blade-submit]');
  await waitFor(
    async () => !(await submit.isDisabled()),
    'Web submit did not become ready',
    30_000
  );
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      candidate.url().includes(`/sessions/${sessionId}/message`)
  );
  await submit.click();
  const accepted = await response;
  if (accepted.status() !== 202) {
    throw new Error(`Web message failed with HTTP ${accepted.status()}`);
  }
}

function expectSharedCoordinationIdle(): void {
  expect(sessionInteractionCoordinationStatsForTests()).toEqual({
    keys: 0,
    operations: 0,
  });
  expect(GoalStore.coordinationStatsForTests()).toEqual({
    keys: 0,
    operations: 0,
  });
  expect(OAuthTokenStorage.coordinationStatsForTests()).toEqual({
    keys: 0,
    operations: 0,
  });
}

async function waitForWebCoordinationIdle(): Promise<void> {
  await waitFor(() => {
    const stats = BladeServer.getSessionCoordinationStatsForTests();
    return (
      stats?.messageSubmissions.keys === 0 &&
      stats.messageSubmissions.operations === 0 &&
      stats.taskDeliveries.keys === 0 &&
      stats.taskDeliveries.operations === 0
    );
  }, 'Web keyed coordination did not return to zero');
  expect(BladeServer.getSessionCoordinationStatsForTests()).toEqual({
    messageSubmissions: { keys: 0, operations: 0 },
    taskDeliveries: { keys: 0, operations: 0 },
  });
  expectSharedCoordinationIdle();
}

function createAcpHarness(client: RecordingAcpClient): AcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (productionConnection) => {
      agent = new BladeAgent(productionConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;

  return {
    connection,
    agent: productionAgent,
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown;
        try {
          await productionAgent.destroy();
        } catch (error) {
          firstError = error;
        }
        try {
          const clientWriter = clientToAgent.writable.getWriter();
          const agentWriter = agentToClient.writable.getWriter();
          try {
            await Promise.all([clientWriter.close(), agentWriter.close()]);
          } finally {
            clientWriter.releaseLock();
            agentWriter.releaseLock();
          }
          await Promise.all([connection.closed, agentConnection.closed]);
        } catch (error) {
          firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    },
  };
}

function acpAgentText(client: RecordingAcpClient, sessionId: string): string {
  return client.updates
    .filter((notification) => notification.sessionId === sessionId)
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

async function createAcpSession(
  connection: acp.ClientSideConnection,
  workspace: string
): Promise<string> {
  const session = await connection.newSession({
    cwd: workspace,
    mcpServers: [],
  });
  await connection.setSessionMode({
    sessionId: session.sessionId,
    modeId: 'yolo',
  });
  return session.sessionId;
}

async function promptAcp(
  connection: acp.ClientSideConnection,
  sessionId: string,
  marker: string
): Promise<void> {
  const result = await connection.prompt({
    sessionId,
    prompt: [
      {
        type: 'text',
        text: `Reply with exactly ${marker} and no other text. Do not call tools.`,
      },
    ],
  });
  expect(result.stopReason).toBe('end_turn');
}

describe
  .skipIf(!enabled)
  .sequential('deterministic keyed coordination reclamation (real API)', () => {
    it.each(models)(
      '$model reclaims Web coordination after multi-Session GUI churn',
      async (model) => {
        const root = await mkdtemp(
          path.join(os.tmpdir(), 'blade-keyed-coordination-web-')
        );
        const storageRoot = path.join(root, 'storage');
        const workspace = path.join(root, 'workspace');
        const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
        const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
        const hooks = HookManager.getInstance();
        const hooksWereEnabled = hooks.isEnabled();
        let originalConfig: RuntimeConfig | null = null;
        let server: TestServer | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        const sessionIds: string[] = [];
        const browserFaults: string[] = [];
        let expectedSseAborts = 0;

        try {
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          process.env.BLADE_AUTO_MEMORY = '0';
          hooks.disable();
          await Promise.all([
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspace, { recursive: true }),
          ]);
          await writeFile(path.join(workspace, 'README.md'), '# Coordination\n');
          await initializeIsolatedExtensions(workspace, storageRoot);
          ConfigManager.resetInstance();
          WorkspaceTrustService.resetInstance();
          await WorkspaceTrustService.getInstance().trust(workspace);
          await ensureStoreInitialized();
          originalConfig = getState().config.config;
          getState().config.actions.setConfig(runtimeConfig(model));
          server = await BladeServer.listenAsync({
            port: 0,
            hostname: '127.0.0.1',
          });
          const activeServer = server;

          await runWithCwdOverride(workspace, async () => {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            page.on('pageerror', (error) =>
              browserFaults.push(`pageerror:${error.message}`)
            );
            page.on('console', (message) => {
              if (message.type() === 'error') {
                browserFaults.push(`console:${message.text()}`);
              }
            });
            page.on('requestfailed', (request) => {
              const failure = request.failure()?.errorText ?? 'failed';
              if (
                request.url().includes('/events?') &&
                failure === 'net::ERR_ABORTED'
              ) {
                expectedSseAborts++;
                return;
              }
              browserFaults.push(
                `request:${request.method()} ${request.url()} ${failure}`
              );
            });

            const markers: string[] = [];
            for (let index = 0; index < 2; index++) {
              const marker = `KEYED_WEB_${index}_${Date.now()}`;
              markers.push(marker);
              const sessionId = await createWebSession(
                activeServer,
                workspace,
                `Coordination ${index}`
              );
              sessionIds.push(sessionId);
              await openWebSession(page, activeServer, workspace, sessionId);
              await selectYolo(page);
              await submitWebMessage(
                page,
                sessionId,
                `Reply with exactly ${marker} and no other text. Do not call tools.`
              );
              await page.getByText(marker, { exact: true }).waitFor({
                state: 'visible',
                timeout: 120_000,
              });
              await waitForWebSessionTerminal(activeServer, workspace, sessionId);
              await waitForWebCoordinationIdle();
            }

            const primarySessionId = sessionIds[0];
            if (!primarySessionId) throw new Error('Primary Web Session is missing');
            const followUp = `KEYED_WEB_FOLLOWUP_${Date.now()}`;
            await openWebSession(page, activeServer, workspace, primarySessionId);
            await submitWebMessage(
              page,
              primarySessionId,
              `Reply with exactly ${followUp} and no other text. Do not call tools.`
            );
            await page.getByText(followUp, { exact: true }).waitFor({
              state: 'visible',
              timeout: 120_000,
            });
            await waitForWebSessionTerminal(activeServer, workspace, primarySessionId);
            await waitForWebCoordinationIdle();

            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByText(markers[0] ?? '', { exact: true }).waitFor({
              state: 'visible',
              timeout: 30_000,
            });
            await page.getByText(followUp, { exact: true }).waitFor({
              state: 'visible',
              timeout: 30_000,
            });
            expect(expectedSseAborts).toBe(3);
            expect(browserFaults).toEqual([]);
            expect(await page.content()).not.toContain(model.apiKey);
          });
        } finally {
          await browser?.close().catch(() => undefined);
          if (server) {
            for (const sessionId of sessionIds.reverse()) {
              await deleteWebSession(server, workspace, sessionId).catch(
                () => undefined
              );
            }
            await waitForWebCoordinationIdle().catch(() => undefined);
            await server.stop().catch(() => undefined);
          }
          if (originalConfig) getState().config.actions.setConfig(originalConfig);
          SkillRegistry.resetInstance();
          subagentRegistry.clear();
          subagentRegistry.loadBuiltinAgents();
          ConfigManager.resetInstance();
          WorkspaceTrustService.resetInstance();
          if (hooksWereEnabled) hooks.enable();
          if (originalStorageRoot === undefined) {
            delete process.env.BLADE_STORAGE_ROOT;
          } else {
            process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
          }
          if (originalAutoMemory === undefined) {
            delete process.env.BLADE_AUTO_MEMORY;
          } else {
            process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
          }
          await rm(root, { recursive: true, force: true });
        }
      },
      300_000
    );

    it.each(models)(
      '$model reclaims ACP coordination across one multiplexed connection',
      async (model) => {
        const root = await mkdtemp(
          path.join(os.tmpdir(), 'blade-keyed-coordination-acp-')
        );
        const storageRoot = path.join(root, 'storage');
        const workspace = path.join(root, 'workspace');
        const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
        const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
        const hooks = HookManager.getInstance();
        const hooksWereEnabled = hooks.isEnabled();
        let originalConfig: RuntimeConfig | null = null;
        let harness: AcpHarness | undefined;

        try {
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          process.env.BLADE_AUTO_MEMORY = '0';
          hooks.disable();
          await Promise.all([
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspace, { recursive: true }),
          ]);
          await writeFile(path.join(workspace, 'README.md'), '# Coordination\n');
          await initializeIsolatedExtensions(workspace, storageRoot);
          ConfigManager.resetInstance();
          WorkspaceTrustService.resetInstance();
          await WorkspaceTrustService.getInstance().trust(workspace);
          await ensureStoreInitialized();
          originalConfig = getState().config.config;
          getState().config.actions.setConfig(runtimeConfig(model));

          await runWithCwdOverride(workspace, async () => {
            const client = new RecordingAcpClient();
            harness = createAcpHarness(client);
            const activeHarness = harness;
            const initialized = await activeHarness.connection.initialize({
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { terminal: true },
            });
            expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual(
              {}
            );

            const markers: string[] = [];
            const sessionIds: string[] = [];
            for (let index = 0; index < 2; index++) {
              const marker = `KEYED_ACP_${index}_${Date.now()}`;
              markers.push(marker);
              const sessionId = await createAcpSession(
                activeHarness.connection,
                workspace
              );
              sessionIds.push(sessionId);
              await promptAcp(activeHarness.connection, sessionId, marker);
              expect(acpAgentText(client, sessionId)).toContain(marker);
              await activeHarness.connection.closeSession({ sessionId });
              expectSharedCoordinationIdle();
            }

            const primarySessionId = sessionIds[0];
            if (!primarySessionId) throw new Error('Primary ACP Session is missing');
            await activeHarness.connection.loadSession({
              sessionId: primarySessionId,
              cwd: workspace,
              mcpServers: [],
            });
            await activeHarness.connection.setSessionMode({
              sessionId: primarySessionId,
              modeId: 'yolo',
            });
            const followUp = `KEYED_ACP_FOLLOWUP_${Date.now()}`;
            await promptAcp(activeHarness.connection, primarySessionId, followUp);
            expect(acpAgentText(client, primarySessionId)).toContain(markers[0]);
            expect(acpAgentText(client, primarySessionId)).toContain(followUp);
            await activeHarness.connection.closeSession({
              sessionId: primarySessionId,
            });

            expect(activeHarness.agent.getRuntimeResidencyStats()).toEqual(
              expect.objectContaining({
                resident: 0,
                reserved: 0,
                pinned: 0,
              })
            );
            expectSharedCoordinationIdle();
            expect(JSON.stringify(client.updates)).not.toContain(model.apiKey);
            const primaryMarker = markers[0];
            const secondaryMarker = markers[1];
            const secondarySessionId = sessionIds[1];
            if (!primaryMarker || !secondaryMarker || !secondarySessionId) {
              throw new Error('ACP Session evidence is incomplete');
            }
            const [primaryTranscript, secondaryTranscript] = await Promise.all([
              readFile(findSessionTranscript(storageRoot, primarySessionId), 'utf8'),
              readFile(findSessionTranscript(storageRoot, secondarySessionId), 'utf8'),
            ]);
            expect(primaryTranscript).toContain(primaryMarker);
            expect(primaryTranscript).toContain(followUp);
            expect(secondaryTranscript).toContain(secondaryMarker);
          });
        } finally {
          await harness?.close().catch(() => undefined);
          expectSharedCoordinationIdle();
          if (originalConfig) getState().config.actions.setConfig(originalConfig);
          SkillRegistry.resetInstance();
          subagentRegistry.clear();
          subagentRegistry.loadBuiltinAgents();
          ConfigManager.resetInstance();
          WorkspaceTrustService.resetInstance();
          if (hooksWereEnabled) hooks.enable();
          if (originalStorageRoot === undefined) {
            delete process.env.BLADE_STORAGE_ROOT;
          } else {
            process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
          }
          if (originalAutoMemory === undefined) {
            delete process.env.BLADE_AUTO_MEMORY;
          } else {
            process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
          }
          await rm(root, { recursive: true, force: true });
        }
      },
      300_000
    );
  });
