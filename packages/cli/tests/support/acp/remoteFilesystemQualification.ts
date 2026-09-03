import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { getOrCreateAcpRemoteWorkspaceReference } from '../../../src/acp/AcpRemoteWorkspaceReference.js';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import {
  type BladeConfig,
  PermissionMode,
  type RuntimeConfig,
} from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { createRemoteSessionStateStorage } from '../../../src/context/storage/SessionStateStorage.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import type { AcpRemoteWorkspaceDescriptorV1 } from '../../../src/context/types.js';
import { getModelApiKeyEnvironmentVariable } from '../../../src/services/pi/resolveModelConfig.js';
import {
  type SessionMetadata,
  SessionService,
} from '../../../src/services/SessionService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  type TestModelConfig,
} from '../../integration/real-api/testConfig.js';
import { startRecordingProviderProxy } from '../recordingProviderProxy.js';

export type RemoteFilesystemCleanupPhase =
  | 'agent_destroy'
  | 'client_to_agent_close'
  | 'agent_to_client_close'
  | 'client_connection_closed'
  | 'agent_connection_closed';

export interface CleanupOperation {
  phase: RemoteFilesystemCleanupPhase;
  run(): void | Promise<void>;
  timeoutMessage: string;
}

export interface RemainingDeadlineOptions {
  deadlineAt: number;
  timeoutMessage: string;
}

export interface CleanupRunnerOptions {
  deadlineAt: number;
  bodyError?: unknown;
  operations: readonly CleanupOperation[];
}

export interface QualificationRequestRecord {
  kind: 'read' | 'write';
  path: string;
}

export type CanonicalRemoteFilesystemRequestMethod =
  | typeof acp.CLIENT_METHODS.fs_read_text_file
  | typeof acp.CLIENT_METHODS.fs_write_text_file;

export interface CanonicalRemoteFilesystemQualificationEvidence {
  qualificationId: string;
  frameworkRetryBudget: number;
  requestSequence: string[];
  requestMethodOrder: CanonicalRemoteFilesystemRequestMethod[];
  requestPathIdentities: string[];
  writeResultCount: number;
  hostSourcePreserved: boolean;
  hostOutputParentAbsent: boolean;
  outputContainsFinalMarker: boolean;
  outputExcludesHostCanary: boolean;
}

export class AcpCleanupError extends Error {
  constructor(
    readonly phase: RemoteFilesystemCleanupPhase,
    readonly cause: unknown
  ) {
    super(`ACP cleanup failed during ${phase}`, { cause });
    this.name = 'AcpCleanupError';
  }
}

export function isBenignPairedAcpWriterCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    (error.name === 'TypeError' &&
      message === 'Invalid state: WritableStream is closed') ||
    (message === 'WritableStream is closed' &&
      ('code' in error ? error.code === 'ERR_INVALID_STATE' : false))
  );
}

function classifyEvidencePath(
  candidatePath: string,
  input: { sourcePath: string; outputPath: string }
): 'source' | 'output' | 'other' {
  if (candidatePath === input.sourcePath) return 'source';
  if (candidatePath === input.outputPath) return 'output';
  return 'other';
}

function requestMethodForKind(
  kind: QualificationRequestRecord['kind']
): CanonicalRemoteFilesystemRequestMethod {
  return kind === 'read'
    ? acp.CLIENT_METHODS.fs_read_text_file
    : acp.CLIENT_METHODS.fs_write_text_file;
}

function stablePathRoleIdentity(input: {
  classifiedPath: 'source' | 'output' | 'other';
}): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        role: input.classifiedPath,
      })
    )
    .digest('hex')}`;
}

export function buildRemoteFilesystemQualificationRuntimeConfig(
  base: BladeConfig
): BladeConfig {
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
    models: base.models.map((entry) => ({
      ...entry,
      overrides: { ...entry.overrides, maxRetries: 0 },
    })),
  };
}

export async function withRemainingDeadline<T>(
  operation: () => Promise<T>,
  options: RemainingDeadlineOptions
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        const remaining = Math.max(1, options.deadlineAt - Date.now());
        timer = setTimeout(() => reject(new Error(options.timeoutMessage)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRemoteFilesystemQualificationCleanup(
  options: CleanupRunnerOptions
): Promise<void> {
  const failures: unknown[] = [];
  if (options.bodyError !== undefined) failures.push(options.bodyError);

  for (const operation of options.operations) {
    try {
      await withRemainingDeadline(
        async () => {
          await operation.run();
        },
        {
          deadlineAt: options.deadlineAt,
          timeoutMessage: operation.timeoutMessage,
        }
      );
    } catch (error) {
      failures.push(new AcpCleanupError(operation.phase, error));
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'ACP remote filesystem qualification failed');
  }
}

export function buildCanonicalRemoteFilesystemQualificationEvidence(input: {
  qualificationId: string;
  frameworkRetryBudget: number;
  sourcePath: string;
  outputPath: string;
  requests: readonly QualificationRequestRecord[];
  writeResultCount: number;
  hostSourcePreserved: boolean;
  hostOutputParentAbsent: boolean;
  outputContainsFinalMarker: boolean;
  outputExcludesHostCanary: boolean;
}): CanonicalRemoteFilesystemQualificationEvidence {
  return {
    qualificationId: input.qualificationId,
    frameworkRetryBudget: input.frameworkRetryBudget,
    requestSequence: input.requests.map((request) => {
      const label = classifyEvidencePath(request.path, input);
      return `${request.kind}:${label}`;
    }),
    requestMethodOrder: input.requests.map((request) =>
      requestMethodForKind(request.kind)
    ),
    requestPathIdentities: input.requests.map((request) =>
      stablePathRoleIdentity({
        classifiedPath: classifyEvidencePath(request.path, input),
      })
    ),
    writeResultCount: input.writeResultCount,
    hostSourcePreserved: input.hostSourcePreserved,
    hostOutputParentAbsent: input.hostOutputParentAbsent,
    outputContainsFinalMarker: input.outputContainsFinalMarker,
    outputExcludesHostCanary: input.outputExcludesHostCanary,
  };
}

export function digestCanonicalRemoteFilesystemQualificationEvidence(
  evidence: CanonicalRemoteFilesystemQualificationEvidence
): string {
  const canonical = {
    frameworkRetryBudget: evidence.frameworkRetryBudget,
    hostOutputParentAbsent: evidence.hostOutputParentAbsent,
    hostSourcePreserved: evidence.hostSourcePreserved,
    outputContainsFinalMarker: evidence.outputContainsFinalMarker,
    outputExcludesHostCanary: evidence.outputExcludesHostCanary,
    qualificationId: evidence.qualificationId,
    requestMethodOrder: [...evidence.requestMethodOrder],
    requestPathIdentities: [...evidence.requestPathIdentities],
    requestSequence: [...evidence.requestSequence],
    writeResultCount: evidence.writeResultCount,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

interface PairedAcpProviderRequestEvidence {
  readonly pathname: string;
  readonly bodyBytes: number;
}

export interface PairedAcpFixtureSeedContext {
  readonly model: TestModelConfig;
  readonly frameworkRetryBudget: number;
  readonly home: string;
  readonly storageRoot: string;
  readonly hostWorkspace: string;
  readonly remoteWorkspacePath: string;
  readonly remoteSourcePath: string;
  readonly remoteOutputPath: string;
  readonly hostCanary: string;
  readonly remoteSource: string;
  readonly finalMarker: string;
}

export interface PairedAcpFixtureSeedResult {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly remoteWorkspace: AcpRemoteWorkspaceDescriptorV1;
  readonly providerRequests: readonly PairedAcpProviderRequestEvidence[];
  readonly remoteFilesystemRequests: readonly QualificationRequestRecord[];
  readonly acpTerminalCreateCount: number;
  readonly acpTerminalOutputCount: number;
  readonly notificationCount: number;
  readonly writeResultCount: number;
  readonly finalAssistantText: string;
}

export type PairedAcpFixtureSeed = (
  context: PairedAcpFixtureSeedContext
) => Promise<PairedAcpFixtureSeedResult>;

export interface PairedAcpFixtureActivityCounts {
  readonly providerRequestCount: number;
  readonly acpFileReadCount: number;
  readonly acpFileWriteCount: number;
  readonly acpTerminalCreateCount: number;
  readonly acpTerminalOutputCount: number;
  readonly notificationCount: number;
}

export interface PairedAcpFixtureSessionRef {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly workspaceRef: string;
  readonly remoteWorkspacePath: string;
  readonly remoteSourcePath: string;
  readonly remoteOutputPath: string;
  readonly home: string;
  readonly storageRoot: string;
  readonly hostWorkspace: string;
  readonly forbiddenSurfaceValues: readonly string[];
  readMetadata(): Promise<SessionMetadata | undefined>;
  readTranscript(): Promise<string>;
  readActivityCounts(): PairedAcpFixtureActivityCounts;
  buildLaunchEnv(baseEnv?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv;
}

export interface PairedAcpProductionFixture {
  readonly ownerDisconnected: true;
  readonly serializableEvidence: Readonly<{
    providerRequestCount: number;
    acpFileReadCount: number;
    acpFileWriteCount: number;
    acpTerminalCreateCount: number;
    acpTerminalOutputCount: number;
    notificationCount: number;
    writeResultCount: number;
    historyMessageCount: number;
    frameworkRetryBudget: number;
    modelRetryBudget: 0;
    providerRequestDigest: string;
    remoteFilesystemEvidenceDigest: string;
    finalAssistantTextDigest: string;
    transcriptDigest: string;
  }>;
  readonly serializableCoordinates: Readonly<{
    sessionIdDigest: string;
    projectPathDigest: string;
    remoteWorkspaceDigest: string;
    workspaceRefDigest: string;
  }>;
  withSessionRef(
    callback: (reference: PairedAcpFixtureSessionRef) => undefined | Promise<undefined>
  ): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CreatePairedAcpProductionFixtureOptions {
  readonly model: TestModelConfig;
  readonly frameworkRetryBudget: number;
  readonly fixtureRoot: string;
  readonly testOnly?: Readonly<{
    marker: 'unit-only';
    seed: PairedAcpFixtureSeed;
  }>;
}

interface QualificationAcpFileRequest extends QualificationRequestRecord {
  readonly sessionId: string;
}

class QualificationAcpClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: QualificationAcpFileRequest[] = [];
  readonly updates: acp.SessionNotification[] = [];
  terminalCreateCount = 0;
  terminalOutputCount = 0;

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    this.requests.push({
      kind: 'read',
      sessionId: params.sessionId,
      path: params.path,
    });
    const content = this.files.get(params.path);
    if (content === undefined) {
      throw acp.RequestError.resourceNotFound('remote fixture resource');
    }
    return { content };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    this.requests.push({
      kind: 'write',
      sessionId: params.sessionId,
      path: params.path,
    });
    this.files.set(params.path, params.content);
    return {};
  }

  async createTerminal(
    _params: acp.CreateTerminalRequest
  ): Promise<acp.CreateTerminalResponse> {
    this.terminalCreateCount += 1;
    throw new Error('Remote terminal is unavailable in this fixture');
  }

  async terminalOutput(
    _params: acp.TerminalOutputRequest
  ): Promise<acp.TerminalOutputResponse> {
    this.terminalOutputCount += 1;
    throw new Error('Remote terminal is unavailable in this fixture');
  }
}

interface ProductionSeedHarness {
  readonly client: QualificationAcpClient;
  readonly connection: acp.ClientSideConnection;
  close(input: { deadlineAt: number; bodyError?: unknown }): Promise<void>;
}

const FIXTURE_TIMEOUT_MS = 240_000;
const FIXTURE_CLOSE_RESERVE_MS = 15_000;
const SYNTHETIC_HISTORY_MESSAGE_COUNT = 54;
const CREDENTIAL_ENV_PREFIXES = [
  'BLADE_MODEL_API_KEY_',
  'BLADE_REAL_API_PROVIDER_KEY_',
] as const;
let fixtureEnvironmentTail: Promise<void> = Promise.resolve();
const activeFixtureLease = new AsyncLocalStorage<{ active: boolean }>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedNonce(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function isCredentialEnvironmentName(name: string): boolean {
  return CREDENTIAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function snapshotCredentialEnvironment(): Map<string, string> {
  return new Map(
    Object.entries(process.env).flatMap(([name, value]) =>
      isCredentialEnvironmentName(name) && value !== undefined ? [[name, value]] : []
    )
  );
}

function restoreCredentialEnvironment(snapshot: ReadonlyMap<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (isCredentialEnvironmentName(name) && !snapshot.has(name)) {
      delete process.env[name];
    }
  }
  for (const [name, value] of snapshot) process.env[name] = value;
}

function restoreEnvironmentVariable(
  name:
    | 'HOME'
    | 'BLADE_STORAGE_ROOT'
    | 'BLADE_AUTO_MEMORY'
    | 'BLADE_TELEMETRY_DISABLED',
  value: string | undefined
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withFixtureEnvironment<T>(
  input: { home: string; storageRoot: string },
  operation: () => Promise<T>
): Promise<T> {
  if (activeFixtureLease.getStore()?.active) {
    throw new Error('Paired ACP fixture operations cannot be nested');
  }
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = fixtureEnvironmentTail;
  fixtureEnvironmentTail = previous.catch(() => undefined).then(() => turn);
  await previous.catch(() => undefined);

  const originalHome = process.env.HOME;
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
  const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
  const originalTelemetry = process.env.BLADE_TELEMETRY_DISABLED;
  const credentialEnvironment = snapshotCredentialEnvironment();
  const lease = { active: true };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    process.env.HOME = input.home;
    process.env.BLADE_STORAGE_ROOT = input.storageRoot;
    process.env.BLADE_AUTO_MEMORY = '0';
    process.env.BLADE_TELEMETRY_DISABLED = '1';
    resetProjectionDbCache();
    outcome = {
      ok: true,
      value: await activeFixtureLease.run(lease, operation),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const failures: unknown[] = outcome.ok ? [] : [outcome.error];
  const cleanupOperations = [
    () => restoreEnvironmentVariable('HOME', originalHome),
    () => restoreEnvironmentVariable('BLADE_STORAGE_ROOT', originalStorageRoot),
    () => restoreEnvironmentVariable('BLADE_AUTO_MEMORY', originalAutoMemory),
    () => restoreEnvironmentVariable('BLADE_TELEMETRY_DISABLED', originalTelemetry),
    () => restoreCredentialEnvironment(credentialEnvironment),
    () => resetProjectionDbCache(),
  ];
  try {
    for (const cleanup of cleanupOperations) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    lease.active = false;
    release();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Paired ACP fixture environment failed');
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function assertReferenceActive(active: boolean): void {
  if (!active) throw new Error('Paired ACP fixture session reference has expired');
}

function createRevocableSessionRef(input: {
  result: PairedAcpFixtureSeedResult;
  workspaceRef: string;
  remoteWorkspacePath: string;
  remoteSourcePath: string;
  remoteOutputPath: string;
  home: string;
  storageRoot: string;
  hostWorkspace: string;
  forbiddenSurfaceValues: readonly string[];
  transcriptPath: string;
  credential: Readonly<{ name: string; value: string }>;
  activityCounts(): PairedAcpFixtureActivityCounts;
}): { reference: PairedAcpFixtureSessionRef; revoke(): void } {
  let active = true;
  const guarded = <T>(value: T): T => {
    assertReferenceActive(active);
    return value;
  };
  const reference: PairedAcpFixtureSessionRef = Object.freeze({
    get sessionId() {
      return guarded(input.result.sessionId);
    },
    get projectPath() {
      return guarded(input.result.projectPath);
    },
    get workspaceRef() {
      return guarded(input.workspaceRef);
    },
    get remoteWorkspacePath() {
      return guarded(input.remoteWorkspacePath);
    },
    get remoteSourcePath() {
      return guarded(input.remoteSourcePath);
    },
    get remoteOutputPath() {
      return guarded(input.remoteOutputPath);
    },
    get home() {
      return guarded(input.home);
    },
    get storageRoot() {
      return guarded(input.storageRoot);
    },
    get hostWorkspace() {
      return guarded(input.hostWorkspace);
    },
    get forbiddenSurfaceValues() {
      return guarded(input.forbiddenSurfaceValues);
    },
    readMetadata: async () => {
      assertReferenceActive(active);
      const metadata = (
        await SessionService.listRemoteSessions({
          descriptor: input.result.remoteWorkspace,
          archived: false,
        })
      ).find((candidate) => candidate.sessionId === input.result.sessionId);
      assertReferenceActive(active);
      return metadata;
    },
    readTranscript: async () => {
      assertReferenceActive(active);
      const transcript = await readFile(input.transcriptPath, 'utf8');
      assertReferenceActive(active);
      return transcript;
    },
    readActivityCounts: () => {
      assertReferenceActive(active);
      return input.activityCounts();
    },
    buildLaunchEnv: (baseEnv = process.env) => {
      assertReferenceActive(active);
      return {
        ...baseEnv,
        HOME: input.home,
        BLADE_STORAGE_ROOT: input.storageRoot,
        BLADE_AUTO_MEMORY: '0',
        BLADE_TELEMETRY_DISABLED: '1',
        [input.credential.name]: input.credential.value,
      };
    },
  });
  return {
    reference,
    revoke: () => {
      active = false;
    },
  };
}

function createProductionSeedHarness(): ProductionSeedHarness {
  const client = new QualificationAcpClient();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  let closePromise: Promise<void> | undefined;
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
  if (!agent) throw new Error('Paired ACP fixture agent was not created');

  const closeWritable = async (
    writable: WritableStream<Uint8Array>,
    deadlineAt: number
  ): Promise<void> => {
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    try {
      writer = writable.getWriter();
    } catch (error) {
      if (isBenignPairedAcpWriterCloseError(error)) return;
      throw error;
    }
    try {
      await withRemainingDeadline(async () => writer.close(), {
        deadlineAt,
        timeoutMessage: 'Paired ACP fixture writable close timed out',
      });
    } catch (error) {
      if (!isBenignPairedAcpWriterCloseError(error)) throw error;
    } finally {
      writer.releaseLock();
    }
  };

  return {
    client,
    connection,
    close: ({ deadlineAt, bodyError }) => {
      closePromise ??= (async () => {
        const closeDeadline = Math.max(Date.now() + 1, deadlineAt);
        await runRemoteFilesystemQualificationCleanup({
          deadlineAt,
          bodyError,
          operations: [
            {
              phase: 'agent_destroy',
              run: async () => {
                const currentAgent = agent;
                if (!currentAgent)
                  throw new Error('Paired ACP fixture agent is absent');
                await currentAgent.destroy();
              },
              timeoutMessage: 'Paired ACP fixture agent destroy timed out',
            },
            {
              phase: 'client_to_agent_close',
              run: () => closeWritable(clientToAgent.writable, closeDeadline),
              timeoutMessage: 'Paired ACP fixture client transport close timed out',
            },
            {
              phase: 'agent_to_client_close',
              run: () => closeWritable(agentToClient.writable, closeDeadline),
              timeoutMessage: 'Paired ACP fixture agent transport close timed out',
            },
            {
              phase: 'client_connection_closed',
              run: () =>
                withRemainingDeadline(async () => connection.closed, {
                  deadlineAt,
                  timeoutMessage: 'Paired ACP fixture client close timed out',
                }),
              timeoutMessage: 'Paired ACP fixture client close timed out',
            },
            {
              phase: 'agent_connection_closed',
              run: () =>
                withRemainingDeadline(async () => agentConnection.closed, {
                  deadlineAt,
                  timeoutMessage: 'Paired ACP fixture agent close timed out',
                }),
              timeoutMessage: 'Paired ACP fixture agent close timed out',
            },
          ],
        });
      })();
      return closePromise;
    },
  };
}

function finalAssistantText(updates: readonly acp.SessionNotification[]): string {
  return updates
    .flatMap(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : []
    )
    .join('');
}

function countSuccessfulWriteResults(
  updates: readonly acp.SessionNotification[]
): number {
  const writeIds = new Set(
    updates.flatMap(({ update }) =>
      update.sessionUpdate === 'tool_call' && update.title === 'Executing Write'
        ? [update.toolCallId]
        : []
    )
  );
  return updates.filter(
    ({ update }) =>
      update.sessionUpdate === 'tool_call_update' &&
      writeIds.has(update.toolCallId) &&
      update.status === 'completed'
  ).length;
}

function buildSeedPrompt(context: PairedAcpFixtureSeedContext): string {
  return [
    'You are operating against an ACP-owned remote filesystem.',
    `Use Read exactly once on the exact absolute path ${context.remoteSourcePath}.`,
    'Do not call Write, Edit, Bash, Glob, Grep, or any other tool.',
    `After Read succeeds, reply with exactly ${context.finalMarker} and nothing else.`,
    'Never repeat the file content or path.',
  ].join(' ');
}

async function runProductionSeed(
  context: PairedAcpFixtureSeedContext,
  runtimeConfig: RuntimeConfig,
  providerRequests: () => readonly PairedAcpProviderRequestEvidence[]
): Promise<PairedAcpFixtureSeedResult> {
  const harness = createProductionSeedHarness();
  harness.client.files.set(context.remoteSourcePath, context.remoteSource);
  const deadlineAt = Date.now() + FIXTURE_TIMEOUT_MS;
  const promptDeadlineAt = deadlineAt - FIXTURE_CLOSE_RESERVE_MS;
  let bodyError: unknown;
  let result: PairedAcpFixtureSeedResult | undefined;
  let originalConfig: RuntimeConfig | null = null;

  try {
    await ensureStoreInitialized();
    originalConfig = getState().config.config;
    if (!originalConfig) throw new Error('Blade runtime config is unavailable');
    getState().config.actions.setConfig(runtimeConfig);
    await runWithCwdOverride(context.hostWorkspace, async () => {
      await harness.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
      const created = await harness.connection.newSession({
        cwd: context.remoteWorkspacePath,
        mcpServers: [],
      });
      await harness.connection.setSessionMode({
        sessionId: created.sessionId,
        modeId: 'yolo',
      });
      const promptResult = await withRemainingDeadline(
        () =>
          harness.connection.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: buildSeedPrompt(context) }],
          }),
        {
          deadlineAt: promptDeadlineAt,
          timeoutMessage: 'Paired ACP fixture prompt timed out',
        }
      );
      if (promptResult.stopReason !== 'end_turn') {
        throw new Error('Paired ACP fixture prompt did not complete');
      }
      const metadata = (
        await SessionService.listRemoteSessions({ archived: false })
      ).find((candidate) => candidate.sessionId === created.sessionId);
      if (!metadata?.remoteWorkspace) {
        throw new Error('Paired ACP fixture remote metadata is unavailable');
      }
      const assistantText = finalAssistantText(harness.client.updates);
      if (
        harness.client.requests.length !== 1 ||
        harness.client.requests[0]?.kind !== 'read' ||
        harness.client.requests[0]?.path !== context.remoteSourcePath
      ) {
        throw new Error('Paired ACP fixture did not perform the single required Read');
      }
      if (
        harness.client.terminalCreateCount !== 0 ||
        harness.client.terminalOutputCount !== 0
      ) {
        throw new Error('Paired ACP fixture unexpectedly used a remote terminal');
      }
      if (!assistantText.includes(context.finalMarker)) {
        throw new Error('Paired ACP fixture final marker is unavailable');
      }
      result = {
        sessionId: created.sessionId,
        projectPath: metadata.projectPath,
        remoteWorkspace: metadata.remoteWorkspace,
        providerRequests: providerRequests(),
        remoteFilesystemRequests: harness.client.requests.map(({ kind, path }) => ({
          kind,
          path,
        })),
        acpTerminalCreateCount: harness.client.terminalCreateCount,
        acpTerminalOutputCount: harness.client.terminalOutputCount,
        notificationCount: harness.client.updates.length,
        writeResultCount: countSuccessfulWriteResults(harness.client.updates),
        finalAssistantText: assistantText,
      };
    });
  } catch (error) {
    bodyError = error;
  }

  const cleanupFailures: unknown[] = [];
  if (originalConfig) {
    try {
      getState().config.actions.setConfig(originalConfig);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await harness.close({ deadlineAt });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (bodyError !== undefined || cleanupFailures.length > 0) {
    const failures = [
      ...(bodyError === undefined ? [] : [bodyError]),
      ...cleanupFailures,
    ];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, 'Paired ACP fixture seed failed');
  }

  if (!result) throw new Error('Paired ACP fixture seed produced no result');
  return result;
}

function selectedCredentialEnvironment(
  config: BladeConfig,
  model: TestModelConfig
): Readonly<{ name: string; value: string }> {
  const selected = config.models.find((entry) => entry.id === config.currentModelId);
  if (!selected) throw new Error('Paired ACP fixture selected model is unavailable');
  const customProvider = config.modelProviders[selected.provider];
  return {
    name: customProvider?.apiKeyEnv ?? getModelApiKeyEnvironmentVariable(selected.id),
    value: model.apiKey,
  };
}

async function appendSyntheticHistory(
  result: PairedAcpFixtureSeedResult
): Promise<number> {
  const persistent = new PersistentStore(
    result.projectPath,
    100,
    undefined,
    createRemoteSessionStateStorage(result.projectPath, result.remoteWorkspace)
  );
  for (let index = 1; index <= SYNTHETIC_HISTORY_MESSAGE_COUNT; index += 1) {
    const role = index % 2 === 1 ? 'user' : 'assistant';
    await persistent.saveMessage(
      result.sessionId,
      role,
      `Qualification history page item ${String(index).padStart(3, '0')}`
    );
  }
  const messages = await SessionService.loadRemoteSession(
    result.sessionId,
    result.projectPath,
    result.remoteWorkspace
  );
  return messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant'
  ).length;
}

function providerEvidenceDigest(
  requests: readonly PairedAcpProviderRequestEvidence[]
): string {
  return digest(
    JSON.stringify(
      requests.map((request) => ({
        bodyBytes: request.bodyBytes,
        pathname: request.pathname,
      }))
    )
  );
}

function remoteFilesystemEvidenceDigest(
  context: PairedAcpFixtureSeedContext,
  result: PairedAcpFixtureSeedResult,
  input: {
    hostSourcePreserved: boolean;
    hostOutputParentAbsent: boolean;
    outputContainsFinalMarker: boolean;
    outputExcludesHostCanary: boolean;
  }
): string {
  return digestCanonicalRemoteFilesystemQualificationEvidence(
    buildCanonicalRemoteFilesystemQualificationEvidence({
      qualificationId: context.model.qualificationId,
      frameworkRetryBudget: context.frameworkRetryBudget,
      sourcePath: context.remoteSourcePath,
      outputPath: context.remoteOutputPath,
      requests: result.remoteFilesystemRequests,
      writeResultCount: result.writeResultCount,
      hostSourcePreserved: input.hostSourcePreserved,
      hostOutputParentAbsent: input.hostOutputParentAbsent,
      outputContainsFinalMarker: input.outputContainsFinalMarker,
      outputExcludesHostCanary: input.outputExcludesHostCanary,
    })
  );
}

export async function createPairedAcpProductionFixture(
  options: CreatePairedAcpProductionFixtureOptions
): Promise<PairedAcpProductionFixture> {
  if (!path.isAbsolute(options.fixtureRoot)) {
    throw new Error('Paired ACP fixture root must be absolute');
  }
  if (
    !Number.isSafeInteger(options.frameworkRetryBudget) ||
    options.frameworkRetryBudget < 0
  ) {
    throw new Error('Paired ACP framework retry budget must be non-negative');
  }
  if (!options.testOnly && !isRealApiTestEnabled()) {
    throw new Error('Production paired ACP fixture requires REAL_API_TEST=1');
  }
  if (!options.testOnly && options.frameworkRetryBudget !== 0) {
    throw new Error('Production paired ACP fixture requires framework retry 0');
  }
  if (
    options.testOnly &&
    (isRealApiTestEnabled() || process.env.REAL_API_RELEASE_MATRIX === '1')
  ) {
    throw new Error('Deterministic paired ACP seed is unavailable in real API runs');
  }

  const home = path.join(options.fixtureRoot, 'home');
  const storageRoot = path.join(options.fixtureRoot, 'storage');
  const hostWorkspace = path.join(options.fixtureRoot, 'host-runtime');
  const remoteWorkspacePath = path.join(options.fixtureRoot, 'workspace');
  const remoteSourcePath = path.join(remoteWorkspacePath, 'inputs', 'source.txt');
  const remoteOutputPath = path.join(remoteWorkspacePath, 'outputs', 'result.txt');
  const hostCanary = boundedNonce('HOST_CANARY');
  const remoteCanary = boundedNonce('REMOTE_SOURCE');
  const finalMarker = 'REMOTE_HISTORY_READY';
  const remoteSource = `${remoteCanary}\nownership=paired-acp\n`;
  const createdPaths = [home, storageRoot, hostWorkspace, remoteWorkspacePath] as const;

  const context: PairedAcpFixtureSeedContext = Object.freeze({
    model: options.model,
    frameworkRetryBudget: options.frameworkRetryBudget,
    home,
    storageRoot,
    hostWorkspace,
    remoteWorkspacePath,
    remoteSourcePath,
    remoteOutputPath,
    hostCanary,
    remoteSource,
    finalMarker,
  });
  let proxy: Awaited<ReturnType<typeof startRecordingProviderProxy>> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const cleanupOwnedPaths = async (): Promise<void> => {
    await Promise.all(
      createdPaths.map((target) => rm(target, { recursive: true, force: true }))
    );
  };

  const closeFixtureResources = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      const activeProxy = proxy;
      if (activeProxy) {
        await withRemainingDeadline(() => activeProxy.close(), {
          deadlineAt: Date.now() + FIXTURE_CLOSE_RESERVE_MS,
          timeoutMessage: 'Paired ACP fixture Provider proxy close timed out',
        });
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      resetProjectionDbCache();
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanupOwnedPaths();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Paired ACP fixture cleanup failed');
    }
  };

  try {
    await Promise.all(
      createdPaths.map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 })
      )
    );
    await mkdir(path.dirname(remoteSourcePath), { recursive: true });
    await writeFile(
      remoteSourcePath,
      `${hostCanary}\nhost filesystem must stay untouched\n`
    );

    const prepared = await withFixtureEnvironment({ home, storageRoot }, async () => {
      let runtimeConfig: RuntimeConfig;
      let seed: PairedAcpFixtureSeed;
      if (options.testOnly) {
        runtimeConfig = buildRemoteFilesystemQualificationRuntimeConfig(
          buildRealApiRuntimeConfig(options.model)
        );
        seed = options.testOnly.seed;
      } else {
        proxy = await startRecordingProviderProxy(
          options.model.baseURL ?? 'https://api.deepseek.com'
        );
        runtimeConfig = buildRemoteFilesystemQualificationRuntimeConfig(
          buildRealApiRuntimeConfig({ ...options.model, baseURL: proxy.baseUrl })
        );
        runtimeConfig = { ...runtimeConfig, allowedTools: ['Read'] };
        const activeProxy = proxy;
        seed = (seedContext) =>
          runProductionSeed(seedContext, runtimeConfig, () =>
            activeProxy.requestPaths.map((pathname, index) => {
              const body = activeProxy.requestBodies[index] ?? '';
              return {
                pathname,
                bodyBytes: Buffer.byteLength(body),
              };
            })
          );
      }

      const selectedModel = runtimeConfig.models.find(
        (entry) => entry.id === runtimeConfig.currentModelId
      );
      if (!selectedModel || selectedModel.overrides?.maxRetries !== 0) {
        throw new Error('Paired ACP fixture requires model maxRetries=0');
      }
      await mkdir(path.join(home, '.blade'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(runtimeConfig, null, 2)}\n`,
        { mode: 0o600 }
      );

      return {
        credential: selectedCredentialEnvironment(runtimeConfig, options.model),
        result: await seed(context),
      };
    });
    const { credential, result } = prepared;
    const historyMessageCount = await withFixtureEnvironment(
      { home, storageRoot },
      () => appendSyntheticHistory(result)
    );
    const hostSource = await readFile(remoteSourcePath, 'utf8');
    const hostSourcePreserved =
      hostSource === `${hostCanary}\nhost filesystem must stay untouched\n`;
    if (!hostSourcePreserved) {
      throw new Error('Paired ACP fixture touched the host filesystem canary');
    }
    let hostOutputParentAbsent = false;
    try {
      await access(path.dirname(remoteOutputPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hostOutputParentAbsent = true;
    }
    if (!hostOutputParentAbsent) {
      throw new Error('Paired ACP fixture created a host-side remote output directory');
    }
    const workspaceRef = await withFixtureEnvironment({ home, storageRoot }, () =>
      getOrCreateAcpRemoteWorkspaceReference(result.projectPath, result.remoteWorkspace)
    );
    const transcriptPath = path.join(result.projectPath, `${result.sessionId}.jsonl`);
    const transcript = await withFixtureEnvironment({ home, storageRoot }, () =>
      readFile(transcriptPath, 'utf8')
    );
    const activityCounts = (): PairedAcpFixtureActivityCounts => ({
      providerRequestCount:
        proxy?.requestPaths.length ?? result.providerRequests.length,
      acpFileReadCount: result.remoteFilesystemRequests.filter(
        (request) => request.kind === 'read'
      ).length,
      acpFileWriteCount: result.remoteFilesystemRequests.filter(
        (request) => request.kind === 'write'
      ).length,
      acpTerminalCreateCount: result.acpTerminalCreateCount,
      acpTerminalOutputCount: result.acpTerminalOutputCount,
      notificationCount: result.notificationCount,
    });
    const initialCounts = activityCounts();
    const serializableEvidence = Object.freeze({
      ...initialCounts,
      writeResultCount: result.writeResultCount,
      historyMessageCount,
      frameworkRetryBudget: options.frameworkRetryBudget,
      modelRetryBudget: 0 as const,
      providerRequestDigest: providerEvidenceDigest(result.providerRequests),
      remoteFilesystemEvidenceDigest: remoteFilesystemEvidenceDigest(context, result, {
        hostSourcePreserved,
        hostOutputParentAbsent,
        outputContainsFinalMarker: result.finalAssistantText.includes(
          context.finalMarker
        ),
        outputExcludesHostCanary: !result.finalAssistantText.includes(
          context.hostCanary
        ),
      }),
      finalAssistantTextDigest: digest(result.finalAssistantText),
      transcriptDigest: digest(transcript),
    });
    const serializableCoordinates = Object.freeze({
      sessionIdDigest: digest(result.sessionId),
      projectPathDigest: digest(result.projectPath),
      remoteWorkspaceDigest: digest(JSON.stringify(result.remoteWorkspace)),
      workspaceRefDigest: digest(workspaceRef),
    });
    let cleaned = false;
    const fixture: PairedAcpProductionFixture = {
      ownerDisconnected: true,
      serializableEvidence,
      serializableCoordinates,
      withSessionRef: async (callback) => {
        return withFixtureEnvironment({ home, storageRoot }, async () => {
          if (cleaned) throw new Error('Paired ACP fixture has been cleaned up');
          const access = createRevocableSessionRef({
            result,
            workspaceRef,
            remoteWorkspacePath,
            remoteSourcePath,
            remoteOutputPath,
            home,
            storageRoot,
            hostWorkspace,
            forbiddenSurfaceValues: Object.freeze([
              home,
              storageRoot,
              hostWorkspace,
              remoteSourcePath,
              result.projectPath,
              result.remoteWorkspace.exactIdentity,
              result.remoteWorkspace.collisionIdentity,
              hostCanary,
              remoteCanary,
              remoteSource,
            ]),
            transcriptPath,
            credential,
            activityCounts,
          });
          try {
            const returned = await callback(access.reference);
            if (returned !== undefined) {
              throw new Error(
                'Paired ACP fixture session callbacks cannot return a value'
              );
            }
          } finally {
            access.revoke();
          }
        });
      },
      cleanup: () => {
        if (activeFixtureLease.getStore()?.active) {
          return Promise.reject(
            new Error('Paired ACP fixture operations cannot be nested')
          );
        }
        if (!cleanupPromise) {
          cleaned = true;
          cleanupPromise = withFixtureEnvironment(
            { home, storageRoot },
            closeFixtureResources
          );
        }
        return cleanupPromise;
      },
    };
    return Object.freeze(fixture);
  } catch (error) {
    try {
      await withFixtureEnvironment({ home, storageRoot }, async () => {
        await closeFixtureResources();
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Paired ACP fixture creation and cleanup failed'
      );
    }
    throw error;
  }
}
