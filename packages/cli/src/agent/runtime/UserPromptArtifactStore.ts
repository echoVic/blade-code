import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import {
  MAX_INLINE_USER_MESSAGE_TEXT_BYTES,
  MAX_USER_MESSAGE_TEXT_BYTES,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../../api/attachmentLimits.js';
import type { MessagePersistenceMetadata } from '../../context/types.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import type { JsonObject } from '../../store/types.js';
import type { UserMessageContent } from '../types.js';

export const MAX_USER_PROMPT_ARTIFACTS_PER_SESSION = 128;
export const MAX_USER_PROMPT_ARTIFACT_SESSION_BYTES = 64 * 1024 * 1024;
export const DEFAULT_USER_PROMPT_ARTIFACT_READ_BYTES = 24 * 1024;
export const MAX_USER_PROMPT_ARTIFACT_READ_BYTES = 64 * 1024;

const PROMPT_ARTIFACT_VERSION = 1;
const PROMPT_ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/;
const PROMPT_ARTIFACT_FILE_PATTERN = /^[a-f0-9]{64}\.txt$/;
const MAX_USER_PROMPT_CONTENT_LAYOUT_ENTRIES = 64;
const RETRYABLE_ARTIFACT_ERROR_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']);
const PROMPT_ARTIFACT_ELISION =
  '\n\n...[middle omitted; read the private prompt artifact for the complete request]...\n\n';

type UserPromptArtifactContentLayoutEntry =
  | {
      type: 'text';
      chars: number;
    }
  | {
      type: 'image_url';
    };

export interface UserPromptArtifactReference {
  version: typeof PROMPT_ARTIFACT_VERSION;
  id: string;
  sha256: string;
  sizeBytes: number;
  textChars: number;
  inlineBytes: number;
  contentLayout?: UserPromptArtifactContentLayoutEntry[];
}

export interface MaterializedUserPrompt {
  content: UserMessageContent;
  metadata?: MessagePersistenceMetadata;
  offloaded: boolean;
}

export interface UserPromptArtifactChunk {
  id: string;
  sha256: string;
  sizeBytes: number;
  offset: number;
  nextOffset?: number;
  returnedBytes: number;
  content: string;
}

interface UserPromptArtifactStoreOptions {
  storageRoot: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function safeArtifactError(error: unknown, fallback: string): Error {
  const safeError =
    error instanceof Error &&
    (error.message.startsWith('Prompt artifact') ||
      error.message.startsWith('User prompt'))
      ? error
      : new Error(fallback);
  const code =
    error instanceof Error &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  if (code && RETRYABLE_ARTIFACT_ERROR_CODES.has(code)) {
    (safeError as NodeJS.ErrnoException).code = code;
  }
  return safeError;
}

function isPrivate(stats: Stats): boolean {
  return (
    (!process.getuid || stats.uid === process.getuid()) &&
    (process.platform === 'win32' || (stats.mode & 0o777) === 0o600)
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
  }
  const stats = await fs.lstat(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.getuid && stats.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700)
  ) {
    throw new Error('Prompt artifact directory ownership or permissions are invalid');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function artifactFileName(id: string): string {
  if (!PROMPT_ARTIFACT_ID_PATTERN.test(id)) {
    throw new Error('Prompt artifact ID is invalid');
  }
  return `${id}.txt`;
}

function serializePrompt(content: UserMessageContent): {
  text: string;
  contentLayout?: UserPromptArtifactContentLayoutEntry[];
} {
  if (typeof content === 'string') return { text: content };

  let text = '';
  const contentLayout: UserPromptArtifactContentLayoutEntry[] = [];
  for (const part of content) {
    if (part.type === 'image_url') {
      contentLayout.push({ type: 'image_url' });
      continue;
    }
    if (!part.text) continue;
    text += part.text;
    const previous = contentLayout.at(-1);
    if (previous?.type === 'text') {
      previous.chars += part.text.length;
    } else {
      contentLayout.push({ type: 'text', chars: part.text.length });
    }
  }

  return { text, contentLayout };
}

function contentImages(content: UserMessageContent): ContentPart[] {
  if (typeof content === 'string') return [];
  return content
    .filter((part) => part.type === 'image_url')
    .map((part) => ({
      type: 'image_url' as const,
      image_url: { ...part.image_url },
    }));
}

function appendTextPart(parts: ContentPart[], text: string): void {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === 'text') {
    previous.text += text;
  } else {
    parts.push({ type: 'text', text });
  }
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function truncateUtf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function boundedPromptPreview(
  value: string,
  maxBytes: number
): { head: string; tail: string; elided: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) {
    return { head: value, tail: '', elided: false };
  }
  if (maxBytes <= Buffer.byteLength(PROMPT_ARTIFACT_ELISION)) {
    return {
      head: truncateUtf8Prefix(value, maxBytes),
      tail: '',
      elided: false,
    };
  }
  const contentBytes = maxBytes - Buffer.byteLength(PROMPT_ARTIFACT_ELISION);
  const tailBytes = Math.min(4 * 1024, Math.floor(contentBytes / 2));
  const headBytes = contentBytes - tailBytes;
  return {
    head: truncateUtf8Prefix(value, headBytes),
    tail: truncateUtf8Suffix(value, tailBytes),
    elided: true,
  };
}

function projectPromptContent(
  text: string,
  images: ContentPart[],
  layout: UserPromptArtifactContentLayoutEntry[] | undefined,
  maxBytes: number,
  notice: string
): UserMessageContent {
  const preview = boundedPromptPreview(text, maxBytes);
  if (!layout || images.length === 0) {
    return `${preview.head}${
      preview.elided ? PROMPT_ARTIFACT_ELISION : ''
    }${preview.tail}${notice}`;
  }

  const projected: ContentPart[] = [];
  const headEnd = preview.head.length;
  const tailStart = text.length - preview.tail.length;
  let textOffset = 0;
  let imageOffset = 0;
  let elisionAdded = false;
  for (const entry of layout) {
    if (entry.type === 'image_url') {
      const image = images[imageOffset++];
      if (!image) {
        throw new Error('Prompt artifact image layout does not match its content');
      }
      projected.push(image);
      continue;
    }

    const partStart = textOffset;
    const partEnd = textOffset + entry.chars;
    if (partStart < headEnd) {
      appendTextPart(projected, text.slice(partStart, Math.min(partEnd, headEnd)));
    }
    const omittedStart = Math.max(partStart, headEnd);
    const omittedEnd = Math.min(partEnd, tailStart);
    if (preview.elided && omittedStart < omittedEnd && !elisionAdded) {
      appendTextPart(projected, PROMPT_ARTIFACT_ELISION);
      elisionAdded = true;
    }
    if (partEnd > tailStart) {
      appendTextPart(projected, text.slice(Math.max(partStart, tailStart), partEnd));
    }
    textOffset = partEnd;
  }
  if (imageOffset !== images.length || textOffset !== text.length) {
    throw new Error('Prompt artifact content layout does not match its content');
  }
  appendTextPart(projected, notice);
  return projected;
}

function parseContentLayout(
  value: unknown,
  expectedTextChars: number
): UserPromptArtifactContentLayoutEntry[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_USER_PROMPT_CONTENT_LAYOUT_ENTRIES
  ) {
    return undefined;
  }

  const layout: UserPromptArtifactContentLayoutEntry[] = [];
  let textChars = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === 'image_url') {
      layout.push({ type: 'image_url' });
      continue;
    }
    if (
      candidate.type !== 'text' ||
      typeof candidate.chars !== 'number' ||
      !Number.isSafeInteger(candidate.chars) ||
      candidate.chars <= 0 ||
      candidate.chars > expectedTextChars
    ) {
      return undefined;
    }
    textChars += candidate.chars;
    layout.push({ type: 'text', chars: candidate.chars });
  }
  return textChars === expectedTextChars ? layout : undefined;
}

function hasPromptArtifactMetadata(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.hasOwn(metadata, 'userPromptArtifact')
  );
}

function promptArtifactReference(
  metadata: unknown
): UserPromptArtifactReference | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const candidate = (metadata as Record<string, unknown>).userPromptArtifact;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const value = candidate as Record<string, unknown>;
  if (
    value.version !== PROMPT_ARTIFACT_VERSION ||
    typeof value.id !== 'string' ||
    !PROMPT_ARTIFACT_ID_PATTERN.test(value.id) ||
    typeof value.sha256 !== 'string' ||
    value.sha256 !== value.id ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= MAX_INLINE_USER_MESSAGE_TEXT_BYTES ||
    value.sizeBytes > MAX_USER_MESSAGE_TEXT_BYTES ||
    typeof value.textChars !== 'number' ||
    !Number.isSafeInteger(value.textChars) ||
    value.textChars <= 0 ||
    value.textChars > MAX_USER_MESSAGE_TEXT_CHARS ||
    typeof value.inlineBytes !== 'number' ||
    !Number.isSafeInteger(value.inlineBytes) ||
    value.inlineBytes <= 0 ||
    value.inlineBytes > MAX_INLINE_USER_MESSAGE_TEXT_BYTES
  ) {
    return undefined;
  }
  const contentLayout = parseContentLayout(value.contentLayout, value.textChars);
  if (value.contentLayout !== undefined && !contentLayout) {
    return undefined;
  }
  return {
    version: PROMPT_ARTIFACT_VERSION,
    id: value.id,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    textChars: value.textChars,
    inlineBytes: value.inlineBytes,
    ...(contentLayout ? { contentLayout } : {}),
  };
}

export function getUserPromptArtifactReference(
  metadata: MessagePersistenceMetadata | undefined
): UserPromptArtifactReference | undefined {
  return promptArtifactReference(metadata);
}

export function collectUserPromptArtifactIds(
  metadataValues: readonly unknown[]
): string[] {
  return [
    ...new Set(
      metadataValues.flatMap((metadata) => {
        const reference = promptArtifactReference(metadata);
        if (!reference && hasPromptArtifactMetadata(metadata)) {
          throw new Error('Prompt artifact reference is invalid');
        }
        return reference ? [reference.id] : [];
      })
    ),
  ];
}

export class UserPromptArtifactStore {
  private readonly root: string;
  private readonly writeMutex = new Mutex();
  private initializePromise?: Promise<void>;
  private artifactCount = 0;
  private storedBytes = 0;

  constructor(
    projectRoot: string,
    sessionId: string,
    options: UserPromptArtifactStoreOptions
  ) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error('Prompt artifact project root must be absolute');
    }
    if (!sessionId || Buffer.byteLength(sessionId) > 256) {
      throw new Error('Prompt artifact Session identity is invalid');
    }
    const projectKey = createHash('sha256')
      .update(path.resolve(projectRoot))
      .digest('hex');
    const sessionKey = createHash('sha256').update(sessionId).digest('hex');
    this.root = path.join(
      options.storageRoot,
      'prompt-artifacts',
      projectKey,
      sessionKey
    );
  }

  async materialize(
    content: UserMessageContent,
    metadata?: MessagePersistenceMetadata
  ): Promise<MaterializedUserPrompt> {
    const existing = promptArtifactReference(metadata);
    if (!existing && hasPromptArtifactMetadata(metadata)) {
      throw new Error('Prompt artifact reference is invalid');
    }
    if (existing) {
      try {
        await this.verify(existing.id, existing.sizeBytes);
      } catch (error) {
        throw safeArtifactError(error, 'Prompt artifact is unavailable or invalid');
      }
      return { content, metadata, offloaded: true };
    }

    const serialized = serializePrompt(content);
    const fullText = serialized.text;
    const bytes = Buffer.from(fullText, 'utf8');
    if (bytes.length <= MAX_INLINE_USER_MESSAGE_TEXT_BYTES) {
      return { content, metadata, offloaded: false };
    }
    if (
      serialized.contentLayout &&
      serialized.contentLayout.length > MAX_USER_PROMPT_CONTENT_LAYOUT_ENTRIES
    ) {
      throw new Error('User prompt contains too many text and image segments');
    }
    if (fullText.length > MAX_USER_MESSAGE_TEXT_CHARS) {
      throw new Error(
        `User prompt exceeds the ${MAX_USER_MESSAGE_TEXT_CHARS}-character durable input limit`
      );
    }
    if (bytes.length > MAX_USER_MESSAGE_TEXT_BYTES) {
      throw new Error(
        `User prompt exceeds the ${MAX_USER_MESSAGE_TEXT_BYTES}-byte durable input limit`
      );
    }

    let reference: UserPromptArtifactReference;
    try {
      reference = await this.write(bytes, fullText.length, serialized.contentLayout);
    } catch (error) {
      throw safeArtifactError(error, 'Prompt artifact could not be stored');
    }
    const notice = [
      '',
      '',
      '[Full user request stored as a private prompt artifact]',
      `artifact_id=${reference.id}`,
      `size_bytes=${reference.sizeBytes}`,
      'Call ReadPromptArtifact with this artifact_id before acting. The complete',
      'request may contain required instructions omitted from the bounded excerpt.',
    ].join('\n');
    const images = contentImages(content);
    const projectedContent = projectPromptContent(
      fullText,
      images,
      serialized.contentLayout,
      MAX_INLINE_USER_MESSAGE_TEXT_BYTES - Buffer.byteLength(notice),
      notice
    );
    return {
      content: projectedContent,
      metadata: {
        ...metadata,
        userPromptArtifact: reference as unknown as JsonObject,
      },
      offloaded: true,
    };
  }

  async restore(
    content: UserMessageContent,
    metadata?: MessagePersistenceMetadata
  ): Promise<UserMessageContent> {
    const reference = promptArtifactReference(metadata);
    if (!reference && hasPromptArtifactMetadata(metadata)) {
      throw new Error('Prompt artifact reference is invalid');
    }
    if (!reference) return content;
    let bytes: Buffer;
    try {
      bytes = await this.readVerified(reference.id, reference.sizeBytes);
    } catch (error) {
      throw safeArtifactError(error, 'Prompt artifact is unavailable or invalid');
    }
    const text = bytes.toString('utf8');
    if (text.length !== reference.textChars) {
      throw new Error('Prompt artifact character count does not match its reference');
    }
    const images = contentImages(content);
    if (!reference.contentLayout) {
      if (images.length > 0) {
        throw new Error('Prompt artifact content layout is missing');
      }
      return text;
    }

    const restored: ContentPart[] = [];
    let textOffset = 0;
    let imageOffset = 0;
    for (const entry of reference.contentLayout) {
      if (entry.type === 'image_url') {
        const image = images[imageOffset++];
        if (!image) {
          throw new Error('Prompt artifact image layout does not match its content');
        }
        restored.push(image);
        continue;
      }
      restored.push({
        type: 'text',
        text: text.slice(textOffset, textOffset + entry.chars),
      });
      textOffset += entry.chars;
    }
    if (textOffset !== text.length || imageOffset !== images.length) {
      throw new Error('Prompt artifact content layout does not match its content');
    }
    return restored;
  }

  async read(
    id: string,
    offset = 0,
    limit = DEFAULT_USER_PROMPT_ARTIFACT_READ_BYTES
  ): Promise<UserPromptArtifactChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Prompt artifact offset must be a non-negative integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > MAX_USER_PROMPT_ARTIFACT_READ_BYTES
    ) {
      throw new Error(
        `Prompt artifact limit must be between 4 and ${MAX_USER_PROMPT_ARTIFACT_READ_BYTES}`
      );
    }
    let bytes: Buffer;
    try {
      bytes = await this.readVerified(id);
    } catch (error) {
      throw safeArtifactError(error, 'Prompt artifact is unavailable or invalid');
    }
    if (offset > bytes.length) {
      throw new Error('Prompt artifact offset exceeds its size');
    }
    let start = offset;
    while (start > 0 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
      start--;
    }
    let end = Math.min(bytes.length, start + limit);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    return {
      id,
      sha256: id,
      sizeBytes: bytes.length,
      offset: start,
      ...(end < bytes.length ? { nextOffset: end } : {}),
      returnedBytes: end - start,
      content: bytes.subarray(start, end).toString('utf8'),
    };
  }

  async copyReferencedTo(
    artifactIds: readonly string[],
    target: UserPromptArtifactStore
  ): Promise<void> {
    try {
      for (const id of new Set(artifactIds)) {
        const bytes = await this.readVerified(id);
        const copied = await target.write(bytes, bytes.toString('utf8').length);
        if (copied.id !== id) {
          throw new Error('Prompt artifact identity changed during copy');
        }
      }
    } catch (error) {
      throw safeArtifactError(error, 'Prompt artifact copy failed');
    }
  }

  async removeAll(): Promise<void> {
    try {
      await fs.rm(this.root, { recursive: true, force: true });
    } catch {
      throw new Error('Prompt artifact cleanup failed');
    }
  }

  private async initialize(): Promise<void> {
    this.initializePromise ??= this.scan().catch((error) => {
      this.initializePromise = undefined;
      throw error;
    });
    return this.initializePromise;
  }

  private async scan(): Promise<void> {
    await ensurePrivateDirectory(path.dirname(path.dirname(this.root)));
    await ensurePrivateDirectory(path.dirname(this.root));
    await ensurePrivateDirectory(this.root);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!PROMPT_ARTIFACT_FILE_PATTERN.test(entry.name)) {
        throw new Error('Prompt artifact store contains an unsafe entry');
      }
      const filePath = path.join(this.root, entry.name);
      const stats = await fs.lstat(filePath);
      if (
        !entry.isFile() ||
        stats.isSymbolicLink() ||
        !isPrivate(stats) ||
        stats.size > MAX_USER_MESSAGE_TEXT_BYTES
      ) {
        throw new Error('Prompt artifact store contains an unsafe entry');
      }
      count++;
      bytes += stats.size;
    }
    if (
      count > MAX_USER_PROMPT_ARTIFACTS_PER_SESSION ||
      bytes > MAX_USER_PROMPT_ARTIFACT_SESSION_BYTES
    ) {
      throw new Error('Prompt artifact Session quota exceeded');
    }
    this.artifactCount = count;
    this.storedBytes = bytes;
  }

  private async write(
    bytes: Buffer,
    textChars: number,
    contentLayout?: UserPromptArtifactContentLayoutEntry[]
  ): Promise<UserPromptArtifactReference> {
    return this.writeMutex.runExclusive(() =>
      this.writeExclusive(bytes, textChars, contentLayout)
    );
  }

  private async writeExclusive(
    bytes: Buffer,
    textChars: number,
    contentLayout?: UserPromptArtifactContentLayoutEntry[]
  ): Promise<UserPromptArtifactReference> {
    await this.initialize();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const filePath = path.join(this.root, artifactFileName(sha256));
    try {
      await this.verify(sha256, bytes.length);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      if (
        this.artifactCount >= MAX_USER_PROMPT_ARTIFACTS_PER_SESSION ||
        this.storedBytes + bytes.length > MAX_USER_PROMPT_ARTIFACT_SESSION_BYTES
      ) {
        throw new Error('Prompt artifact Session quota exceeded');
      }
      let handle;
      try {
        handle = await fs.open(
          filePath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600
        );
        await handle.writeFile(bytes);
        if (process.platform !== 'win32') {
          await handle.chmod(0o600);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(this.root);
        this.artifactCount++;
        this.storedBytes += bytes.length;
      } catch (writeError) {
        await handle?.close().catch(() => undefined);
        if (!isNodeError(writeError, 'EEXIST')) {
          await fs.rm(filePath, { force: true }).catch(() => undefined);
          throw writeError;
        }
        await this.verify(sha256, bytes.length);
      }
    }

    const noticeBytes = Buffer.byteLength(
      [
        '',
        '',
        '[Full user request stored as a private prompt artifact]',
        `artifact_id=${sha256}`,
        `size_bytes=${bytes.length}`,
        'Call ReadPromptArtifact with this artifact_id before acting. The complete',
        'request may contain required instructions omitted from the bounded excerpt.',
      ].join('\n')
    );
    return {
      version: PROMPT_ARTIFACT_VERSION,
      id: sha256,
      sha256,
      sizeBytes: bytes.length,
      textChars,
      inlineBytes: MAX_INLINE_USER_MESSAGE_TEXT_BYTES - noticeBytes,
      ...(contentLayout ? { contentLayout } : {}),
    };
  }

  private async verify(id: string, expectedSize?: number): Promise<void> {
    await this.readVerified(id, expectedSize);
  }

  private async readVerified(id: string, expectedSize?: number): Promise<Buffer> {
    await this.initialize();
    const filePath = path.join(this.root, artifactFileName(id));
    const handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        !isPrivate(stats) ||
        stats.size > MAX_USER_MESSAGE_TEXT_BYTES ||
        (expectedSize !== undefined && stats.size !== expectedSize)
      ) {
        throw new Error('Prompt artifact ownership, permissions, or size are invalid');
      }
      const bytes = await handle.readFile();
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== id) {
        throw new Error('Prompt artifact content hash does not match its identity');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
