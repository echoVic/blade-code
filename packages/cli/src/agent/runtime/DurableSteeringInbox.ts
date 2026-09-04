import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { parseSessionJSONL } from '../../context/storage/JSONLStore.js';
import {
  createSessionStateStorage,
  type SessionStatePaths,
  type SessionStateStorage,
} from '../../context/storage/SessionStateStorage.js';
import {
  type MessagePersistenceMetadata,
  type SessionEvent,
  turnAbortAppliedAcknowledgements,
} from '../../context/types.js';
import { createStructuredOutputContract } from '../../services/StructuredOutputService.js';
import type { JsonObject } from '../../store/types.js';
import type { UserMessageContent } from '../types.js';
import {
  type DurableSteeringInboxLocker,
  withDurableSteeringInboxLock,
} from './DurableSteeringInboxLock.js';

const INBOX_VERSION = 2;
const MAX_INBOX_FILE_BYTES = 8 * 1024 * 1024;

export interface DurableSteeringMessage {
  id: string;
  content: UserMessageContent;
  queuedAt: number;
  recovered: boolean;
  persisted?: boolean;
  outputSchema?: JsonObject;
  origin?: 'user' | 'background_subagent' | 'team_message' | 'interaction_recovery';
  metadata?: MessagePersistenceMetadata;
}

interface InboxRecordV1 {
  version: 1;
  sessionId: string;
  messages: Array<Omit<DurableSteeringMessage, 'recovered'>>;
}

interface InboxRecordV2 {
  version: typeof INBOX_VERSION;
  sessionId: string;
  generation: string;
  messages: Array<Omit<DurableSteeringMessage, 'recovered'>>;
}

type InboxRecord = InboxRecordV1 | InboxRecordV2;

export interface DurableSteeringInboxSnapshot {
  generation: string;
  messages: DurableSteeringMessage[];
}

type AtomicWriter = (
  filePath: string,
  data: string,
  options: { encoding: 'utf8'; mode: number; fsync: true }
) => Promise<void>;

export interface DurableSteeringInboxOptions {
  writeFile?: AtomicWriter;
  lockFile?: DurableSteeringInboxLocker;
}

function serializeInboxRecord(
  sessionId: string,
  generation: string,
  messages: readonly DurableSteeringMessage[]
): string {
  const record: InboxRecordV2 = {
    version: INBOX_VERSION,
    sessionId,
    generation,
    messages: messages.map(({ recovered: _recovered, ...message }) => message),
  };
  return `${JSON.stringify(record)}\n`;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isUserMessageContent(value: unknown): value is UserMessageContent {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!part || typeof part !== 'object' || !('type' in part)) return false;
    if (part.type === 'text') {
      return 'text' in part && typeof part.text === 'string';
    }
    return (
      part.type === 'image_url' &&
      'image_url' in part &&
      typeof part.image_url === 'object' &&
      part.image_url !== null &&
      'url' in part.image_url &&
      typeof part.image_url.url === 'string'
    );
  });
}

function parseInboxRecord(
  raw: string,
  filePath: string,
  sessionId: string
): InboxRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid steering inbox JSON: ${filePath}`, { cause: error });
  }

  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== INBOX_VERSION) ||
    !('sessionId' in value) ||
    value.sessionId !== sessionId ||
    !('messages' in value) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error(`Invalid steering inbox record: ${filePath}`);
  }

  const messages = value.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('id' in message) ||
      typeof message.id !== 'string' ||
      !('content' in message) ||
      !isUserMessageContent(message.content) ||
      !('queuedAt' in message) ||
      typeof message.queuedAt !== 'number' ||
      ('persisted' in message && typeof message.persisted !== 'boolean') ||
      ('origin' in message &&
        message.origin !== 'user' &&
        message.origin !== 'background_subagent' &&
        message.origin !== 'team_message' &&
        message.origin !== 'interaction_recovery') ||
      ('metadata' in message &&
        (message.metadata === null ||
          typeof message.metadata !== 'object' ||
          Array.isArray(message.metadata))) ||
      ('outputSchema' in message &&
        message.outputSchema !== undefined &&
        (!message.outputSchema ||
          typeof message.outputSchema !== 'object' ||
          Array.isArray(message.outputSchema)))
    ) {
      throw new Error(`Invalid steering inbox message: ${filePath}`);
    }
    const outputSchema =
      'outputSchema' in message && message.outputSchema !== undefined
        ? createStructuredOutputContract(message.outputSchema).schema
        : undefined;
    return {
      id: message.id,
      content: message.content,
      queuedAt: message.queuedAt,
      ...('persisted' in message && message.persisted === true
        ? { persisted: true }
        : {}),
      ...('origin' in message && message.origin
        ? {
            origin: message.origin as NonNullable<DurableSteeringMessage['origin']>,
          }
        : {}),
      ...('metadata' in message && message.metadata
        ? {
            metadata: JSON.parse(
              JSON.stringify(message.metadata)
            ) as MessagePersistenceMetadata,
          }
        : {}),
      ...(outputSchema ? { outputSchema } : {}),
    };
  });

  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new Error(`Duplicate steering inbox message: ${filePath}`);
  }
  if (value.version === 1) return { version: 1, sessionId, messages };
  if (
    !('generation' in value) ||
    typeof value.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.generation)
  ) {
    throw new Error(`Invalid steering inbox generation: ${filePath}`);
  }
  return { version: INBOX_VERSION, sessionId, generation: value.generation, messages };
}

function acknowledgedInboxIds(events: SessionEvent[]): Set<string> {
  return new Set(
    events.flatMap((event, index) => {
      if (event.type === 'inbox_acknowledged') return event.data.messageIds;
      if (event.type === 'turn_aborted') {
        return turnAbortAppliedAcknowledgements(events, index);
      }
      return [];
    })
  );
}

export class DurableSteeringInbox {
  private readonly mutex = new Mutex();
  private generation: string = randomUUID();
  private messages: DurableSteeringMessage[] = [];

  private constructor(
    private readonly sessionId: string,
    private readonly stateStorage: SessionStateStorage,
    private readonly writeFile: AtomicWriter,
    private readonly lockFile?: DurableSteeringInboxLocker
  ) {}

  static async open(
    workspaceRoot: string,
    sessionId: string,
    stateStorage: SessionStateStorage = createSessionStateStorage(workspaceRoot),
    options: DurableSteeringInboxOptions = {}
  ): Promise<DurableSteeringInbox> {
    const inbox = new DurableSteeringInbox(
      sessionId,
      stateStorage,
      options.writeFile ?? writeFileAtomic,
      options.lockFile
    );
    await inbox.loadAndReconcile();
    return inbox;
  }

  async enqueue(
    message: Omit<DurableSteeringMessage, 'recovered'>,
    canEnqueue?: (messages: readonly DurableSteeringMessage[]) => boolean
  ): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const result = await withDurableSteeringInboxLock(
        this.stateStorage,
        this.sessionId,
        async (paths) => {
          const current = await this.readAndReconcileAtPath(paths);
          if (current.messages.some((candidate) => candidate.id === message.id)) {
            return { accepted: true, snapshot: current };
          }
          if (canEnqueue && !canEnqueue(current.messages)) {
            return { accepted: false, snapshot: current };
          }
          const next = [...current.messages, { ...message, recovered: false }];
          const generation = randomUUID();
          const serialized = serializeInboxRecord(this.sessionId, generation, next);
          if (Buffer.byteLength(serialized) > MAX_INBOX_FILE_BYTES) {
            return { accepted: false, snapshot: current };
          }
          await this.persistAtPath(next, generation, paths, serialized);
          return {
            accepted: true,
            snapshot: { generation, messages: next },
          };
        },
        this.lockFile
      );
      this.install(result.snapshot);
      return result.accepted;
    });
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const acknowledged = new Set(ids);
    await this.mutex.runExclusive(async () => {
      const next = await withDurableSteeringInboxLock(
        this.stateStorage,
        this.sessionId,
        async (paths) => {
          const current = await this.readAndReconcileAtPath(paths);
          const messages = current.messages.filter(
            (message) => !acknowledged.has(message.id)
          );
          if (
            messages.length === current.messages.length &&
            !current.acknowledgedRemoved
          ) {
            return current;
          }
          const generation = randomUUID();
          await this.persistAtPath(messages, generation, paths);
          return { generation, messages };
        },
        this.lockFile
      );
      this.install(next);
    });
  }

  snapshot(): DurableSteeringInboxSnapshot {
    return { generation: this.generation, messages: this.list() };
  }

  async refresh(): Promise<DurableSteeringInboxSnapshot> {
    return this.mutex.runExclusive(async () => {
      const next = await withDurableSteeringInboxLock(
        this.stateStorage,
        this.sessionId,
        (paths) => this.readAndReconcileAtPath(paths),
        this.lockFile
      );
      this.install(next);
      return this.snapshot();
    });
  }

  list(): DurableSteeringMessage[] {
    return this.messages.map((message) => ({
      ...message,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) =>
              part.type === 'text'
                ? { ...part }
                : { ...part, image_url: { ...part.image_url } }
            ),
      ...(message.outputSchema
        ? {
            outputSchema: JSON.parse(
              JSON.stringify(message.outputSchema)
            ) as JsonObject,
          }
        : {}),
      ...(message.metadata
        ? {
            metadata: JSON.parse(
              JSON.stringify(message.metadata)
            ) as MessagePersistenceMetadata,
          }
        : {}),
    }));
  }

  count(): number {
    return this.messages.length;
  }

  recoveredCount(): number {
    return this.messages.filter((message) => message.recovered).length;
  }

  private async loadAndReconcile(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const next = await withDurableSteeringInboxLock(
        this.stateStorage,
        this.sessionId,
        async (paths) => {
          const current = await this.readAndReconcileAtPath(paths);
          if (current.migrationRequired || current.acknowledgedRemoved) {
            const generation = randomUUID();
            await this.persistAtPath(current.messages, generation, paths);
            return { generation, messages: current.messages };
          }
          return current;
        },
        this.lockFile
      );
      this.install(next);
    });
  }

  private install(snapshot: DurableSteeringInboxSnapshot): void {
    this.generation = snapshot.generation;
    this.messages = snapshot.messages;
  }

  private async readAndReconcileAtPath(paths: SessionStatePaths): Promise<
    DurableSteeringInboxSnapshot & {
      migrationRequired?: boolean;
      acknowledgedRemoved?: boolean;
    }
  > {
    let record: InboxRecord | undefined;
    try {
      const handle = await fs.open(paths.inboxPath, 'r');
      try {
        const stats = await handle.stat();
        if (stats.size > MAX_INBOX_FILE_BYTES) {
          throw new Error(
            `Steering inbox exceeds ${MAX_INBOX_FILE_BYTES} bytes: ${paths.inboxPath}`
          );
        }
        record = parseInboxRecord(
          await handle.readFile('utf8'),
          paths.inboxPath,
          this.sessionId
        );
      } finally {
        await handle.close();
      }
      await fs.chmod(paths.inboxPath, 0o600);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    let acknowledged = new Set<string>();
    try {
      acknowledged = acknowledgedInboxIds(
        parseSessionJSONL(
          await fs.readFile(paths.transcriptPath, 'utf8'),
          paths.transcriptPath
        )
      );
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    const knownRecovery = new Map(
      this.messages.map((message) => [message.id, message.recovered] as const)
    );
    const messages = (record?.messages ?? [])
      .filter((message) => !acknowledged.has(message.id))
      .map((message) => ({
        ...message,
        recovered: knownRecovery.get(message.id) ?? true,
      }));
    return {
      generation: record?.version === 2 ? record.generation : randomUUID(),
      messages,
      ...(record?.version === 1 && messages.length > 0
        ? { migrationRequired: true }
        : {}),
      ...(record && messages.length !== record.messages.length
        ? { acknowledgedRemoved: true }
        : {}),
    };
  }

  private async persistAtPath(
    messages: DurableSteeringMessage[],
    generation: string,
    paths: SessionStatePaths,
    serializedRecord?: string
  ): Promise<void> {
    await fs.mkdir(path.dirname(paths.inboxPath), {
      recursive: true,
      mode: 0o700,
    });

    if (messages.length === 0) {
      await fs.unlink(paths.inboxPath).catch((error) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
      return;
    }

    const serialized =
      serializedRecord ?? serializeInboxRecord(this.sessionId, generation, messages);
    if (Buffer.byteLength(serialized) > MAX_INBOX_FILE_BYTES) {
      throw new Error(
        `Steering inbox exceeds ${MAX_INBOX_FILE_BYTES} bytes: ${paths.inboxPath}`
      );
    }
    await this.writeFile(paths.inboxPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
  }
}
