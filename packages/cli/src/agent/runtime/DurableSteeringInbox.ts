import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { parseSessionJSONL } from '../../context/storage/JSONLStore.js';
import {
  createSessionStateStorage,
  type SessionStatePaths,
  type SessionStateStorage,
  withSessionStatePaths,
} from '../../context/storage/SessionStateStorage.js';
import {
  type MessagePersistenceMetadata,
  type SessionEvent,
  turnAbortAppliedAcknowledgements,
} from '../../context/types.js';
import { createStructuredOutputContract } from '../../services/StructuredOutputService.js';
import type { JsonObject } from '../../store/types.js';
import type { UserMessageContent } from '../types.js';

const INBOX_VERSION = 1;
const MAX_INBOX_FILE_BYTES = 8 * 1024 * 1024;

export interface DurableSteeringMessage {
  id: string;
  content: UserMessageContent;
  queuedAt: number;
  recovered: boolean;
  persisted?: boolean;
  outputSchema?: JsonObject;
  origin?: 'user' | 'background_subagent' | 'team_message';
  metadata?: MessagePersistenceMetadata;
}

interface InboxRecord {
  version: typeof INBOX_VERSION;
  sessionId: string;
  messages: Array<Omit<DurableSteeringMessage, 'recovered'>>;
}

function serializeInboxRecord(
  sessionId: string,
  messages: readonly DurableSteeringMessage[]
): string {
  const record: InboxRecord = {
    version: INBOX_VERSION,
    sessionId,
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
    value.version !== INBOX_VERSION ||
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
        message.origin !== 'team_message') ||
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
            origin: message.origin as 'user' | 'background_subagent' | 'team_message',
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

  return { version: INBOX_VERSION, sessionId, messages };
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
  private messages: DurableSteeringMessage[] = [];

  private constructor(
    private readonly sessionId: string,
    private readonly stateStorage: SessionStateStorage
  ) {}

  static async open(
    workspaceRoot: string,
    sessionId: string,
    stateStorage: SessionStateStorage = createSessionStateStorage(workspaceRoot)
  ): Promise<DurableSteeringInbox> {
    const inbox = new DurableSteeringInbox(sessionId, stateStorage);
    await inbox.loadAndReconcile();
    return inbox;
  }

  async enqueue(
    message: Omit<DurableSteeringMessage, 'recovered'>,
    canEnqueue?: (messages: readonly DurableSteeringMessage[]) => boolean
  ): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      if (canEnqueue && !canEnqueue(this.messages)) {
        return false;
      }
      const next = [...this.messages, { ...message, recovered: false }];
      const serialized = serializeInboxRecord(this.sessionId, next);
      if (Buffer.byteLength(serialized) > MAX_INBOX_FILE_BYTES) {
        return false;
      }
      await this.persist(next, serialized);
      this.messages = next;
      return true;
    });
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const acknowledged = new Set(ids);
    await this.mutex.runExclusive(async () => {
      const next = this.messages.filter((message) => !acknowledged.has(message.id));
      this.messages = next;
      await this.persist(next);
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
      await withSessionStatePaths(this.stateStorage, this.sessionId, async (paths) => {
        let record: InboxRecord = {
          version: INBOX_VERSION,
          sessionId: this.sessionId,
          messages: [],
        };
        try {
          const stats = await fs.stat(paths.inboxPath);
          if (stats.size > MAX_INBOX_FILE_BYTES) {
            throw new Error(
              `Steering inbox exceeds ${MAX_INBOX_FILE_BYTES} bytes: ${paths.inboxPath}`
            );
          }
          await fs.chmod(paths.inboxPath, 0o600);
          record = parseInboxRecord(
            await fs.readFile(paths.inboxPath, 'utf8'),
            paths.inboxPath,
            this.sessionId
          );
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

        const next = record.messages
          .filter((message) => !acknowledged.has(message.id))
          .map((message) => ({ ...message, recovered: true }));
        this.messages = next;
        if (next.length !== record.messages.length) {
          await this.persistAtPath(next, paths);
        }
      });
    });
  }

  private async persist(
    messages: DurableSteeringMessage[],
    serializedRecord?: string
  ): Promise<void> {
    await withSessionStatePaths(this.stateStorage, this.sessionId, (paths) =>
      this.persistAtPath(messages, paths, serializedRecord)
    );
  }

  private async persistAtPath(
    messages: DurableSteeringMessage[],
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
      serializedRecord ?? serializeInboxRecord(this.sessionId, messages);
    if (Buffer.byteLength(serialized) > MAX_INBOX_FILE_BYTES) {
      throw new Error(
        `Steering inbox exceeds ${MAX_INBOX_FILE_BYTES} bytes: ${paths.inboxPath}`
      );
    }
    await writeFileAtomic(paths.inboxPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
  }
}
