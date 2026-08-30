import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
  isAcpMode,
  isAcpRemoteFileSystem,
} from '../../src/acp/AcpServiceContext.js';
import { editTool } from '../../src/tools/builtin/file/edit.js';
import { FileAccessTracker } from '../../src/tools/builtin/file/FileAccessTracker.js';
import { readTool } from '../../src/tools/builtin/file/read.js';
import { writeTool } from '../../src/tools/builtin/file/write.js';
import { ControlledFileClient } from '../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';

describe('ACP remote Read builtin tool', () => {
  const harnesses: PairedAcpHarness[] = [];
  const sessionIds = new Set<string>();
  const tempRoots: string[] = [];

  beforeEach(() => {
    FileAccessTracker.resetInstance();
  });

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      AcpServiceContext.destroySession(sessionId);
    }
    sessionIds.clear();
    FileAccessTracker.resetInstance();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  function initializeRemoteSession(
    client: ControlledFileClient,
    sessionId: string,
    cwd: string
  ): void {
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    sessionIds.add(sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      { fs: { readTextFile: true } },
      cwd
    );
  }

  async function executeRead(
    filePath: string,
    sessionId: string,
    options?: {
      offset?: number;
      limit?: number;
      encoding?: 'utf8' | 'base64' | 'binary';
    }
  ) {
    return readTool.execute(
      {
        file_path: filePath,
        encoding: options?.encoding ?? 'utf8',
        offset: options?.offset,
        limit: options?.limit,
      },
      undefined,
      { sessionId }
    );
  }

  it('remote Read returns remote UTF-8 text through one ACP read and no host metadata', async () => {
    const root = await createTempRoot('blade-acp-remote-read-');
    const filePath = path.join(root, 'remote-only.unknown');
    const hostCanary = 'host canary text\nshould stay local\n';
    const remoteContent = 'remote utf8 line 1\n第二行 remote\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, remoteContent);
    const readSpy = vi.spyOn(client, 'readTextFile');
    const sessionId = 'remote-read-success';
    initializeRemoteSession(client, sessionId, root);

    const result = await executeRead(filePath, sessionId);

    expect(result).toMatchObject({
      success: true,
      llmContent: remoteContent,
      metadata: {
        file_path: filePath,
        file_size: Buffer.byteLength(remoteContent, 'utf8'),
        file_type: '.unknown',
        encoding: 'utf8',
        acp_mode: true,
      },
    });
    expect(result.metadata?.last_modified).toBeUndefined();
    expect(result.metadata?.acp_fallback).toBeUndefined();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
    const tracker = FileAccessTracker.getInstance();
    expect(tracker.getTrackedRecords()).toEqual([]);
    const service = getAcpFileSystemService(sessionId);
    expect(service).toBeInstanceOf(AcpFileSystemService);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.checkRemoteAccess(filePath, remoteContent)).toBe('current');
  });

  it('remote Read slices lines after recording the full remote content digest', async () => {
    const root = await createTempRoot('blade-acp-remote-slice-');
    const filePath = path.join(root, 'slice.me');
    const hostCanary = 'host local\nmust remain unchanged\n';
    const remoteContent = 'zero\none\ntwo\nthree\nfour';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, remoteContent);
    const readSpy = vi.spyOn(client, 'readTextFile');
    const sessionId = 'remote-read-slice';
    initializeRemoteSession(client, sessionId, root);

    const result = await executeRead(filePath, sessionId, { offset: 1, limit: 2 });
    expect(typeof result.llmContent).toBe('string');
    if (typeof result.llmContent !== 'string') {
      throw new Error('expected llmContent to be a string');
    }

    expect(result).toMatchObject({
      success: true,
      llmContent: '     2|one\n     3|two',
      metadata: {
        file_path: filePath,
        file_size: Buffer.byteLength(remoteContent, 'utf8'),
        file_type: '.me',
        encoding: 'utf8',
        acp_mode: true,
        lines_read: 2,
        total_lines: 5,
        start_line: 2,
        end_line: 3,
      },
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.checkRemoteAccess(filePath, remoteContent)).toBe('current');
    expect(service.checkRemoteAccess(filePath, result.llmContent)).toBe('modified');
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Read maps ACP resourceNotFound to File not found without host fallback', async () => {
    const root = await createTempRoot('blade-acp-remote-missing-');
    const filePath = path.join(root, 'missing.txt');
    const hostCanary = 'host file must not be used\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const readSpy = vi.spyOn(client, 'readTextFile');
    const sessionId = 'remote-read-missing';
    initializeRemoteSession(client, sessionId, root);

    const result = await executeRead(filePath, sessionId);

    expect(result.success).toBe(false);
    expect(result.llmContent).toBe(`File not found: ${filePath}`);
    expect(result.error?.type).toBe('execution_error');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
  });

  it.each([
    {
      label: 'permission',
      error: new RequestError(-32020, 'Permission denied'),
      matcher: /Permission denied/,
    },
    {
      label: 'timeout',
      error: new RequestError(-32021, 'Request timed out'),
      matcher: /Request timed out/,
    },
    {
      label: 'disconnect',
      error: new RequestError(-32022, 'Network disconnected'),
      matcher: /Network disconnected/,
    },
    {
      label: 'unknown',
      error: new Error('Unexpected decode failure'),
      matcher: /Internal error/,
    },
  ])(
    'remote Read keeps $label failures as execution errors instead of not-found',
    async ({ error, matcher }) => {
      const root = await createTempRoot('blade-acp-remote-failure-');
      const filePath = path.join(root, 'failing.txt');
      const hostCanary = 'host should remain untouched\n';
      await fs.writeFile(filePath, hostCanary, 'utf8');

      const client = new ControlledFileClient();
      const readSpy = vi.spyOn(client, 'readTextFile').mockRejectedValueOnce(error);
      const sessionId = `remote-read-failure-${Math.random().toString(16).slice(2)}`;
      initializeRemoteSession(client, sessionId, root);

      const result = await executeRead(filePath, sessionId);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('execution_error');
      expect(result.llmContent).toMatch(/^File read failed:/);
      expect(result.llmContent).toMatch(matcher);
      expect(result.llmContent).not.toContain('File not found');
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
    }
  );

  it.each([
    {
      label: 'known binary extension',
      fileName: 'image.png',
      encoding: 'utf8' as const,
    },
    {
      label: 'base64 encoding',
      fileName: 'note.txt',
      encoding: 'base64' as const,
    },
    {
      label: 'binary encoding',
      fileName: 'note.txt',
      encoding: 'binary' as const,
    },
  ])(
    'remote Read rejects $label before any ACP request',
    async ({ fileName, encoding }) => {
      const root = await createTempRoot('blade-acp-remote-binary-');
      const filePath = path.join(root, fileName);
      const hostCanary = 'host canary\n';
      await fs.writeFile(filePath, hostCanary, 'utf8');

      const client = new ControlledFileClient();
      client.files.set(filePath, 'remote text should never be read');
      const readSpy = vi.spyOn(client, 'readTextFile');
      const sessionId = `remote-read-binary-${fileName}-${encoding}`;
      initializeRemoteSession(client, sessionId, root);

      const result = await executeRead(filePath, sessionId, { encoding });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(readSpy).not.toHaveBeenCalled();
      expect(client.requests).toEqual([]);
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
      expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    }
  );

  it('local ACP sessions without fs capabilities keep local Read semantics', async () => {
    const root = await createTempRoot('blade-acp-local-read-');
    const textPath = path.join(root, 'local.txt');
    const binaryPath = path.join(root, 'local.png');
    const unknownPath = path.join(root, 'local.unknown');
    const unknownContent = 'unknown extension still reads as utf8';
    await fs.writeFile(textPath, 'local text\n', 'utf8');
    await fs.writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(unknownPath, unknownContent, 'utf8');

    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const sessionId = 'local-acp-read';
    sessionIds.add(sessionId);
    AcpServiceContext.initializeSession(harness.agentConnection, sessionId, {}, root);

    expect(isAcpMode(sessionId)).toBe(true);
    expect(isAcpRemoteFileSystem(sessionId)).toBe(false);

    const textResult = await executeRead(textPath, sessionId);
    expect(textResult).toMatchObject({
      success: true,
      llmContent: 'local text\n',
      metadata: {
        file_path: textPath,
        encoding: 'utf8',
        acp_mode: true,
        file_type: '.txt',
      },
    });

    const binaryResult = await executeRead(binaryPath, sessionId);
    expect(binaryResult).toMatchObject({
      success: true,
      llmContent: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      metadata: {
        file_path: binaryPath,
        acp_fallback: true,
        encoding: 'base64',
        acp_mode: true,
        is_binary: true,
        file_type: '.png',
      },
    });

    const unknownResult = await executeRead(unknownPath, sessionId);
    expect(unknownResult).toMatchObject({
      success: true,
      llmContent: unknownContent,
      metadata: {
        file_path: unknownPath,
        acp_fallback: true,
        encoding: 'utf8',
        acp_mode: true,
        file_type: '.unknown',
      },
    });
    expect(client.requests).toEqual([]);
  });
});

describe('ACP remote Write/Edit builtin tools', () => {
  const harnesses: PairedAcpHarness[] = [];
  const sessionIds = new Set<string>();
  const tempRoots: string[] = [];

  beforeEach(() => {
    FileAccessTracker.resetInstance();
  });

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      AcpServiceContext.destroySession(sessionId);
    }
    sessionIds.clear();
    FileAccessTracker.resetInstance();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  function initializeRemoteSession(
    client: ControlledFileClient,
    sessionId: string,
    cwd: string,
    capabilities: { readTextFile?: boolean; writeTextFile?: boolean }
  ): void {
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    sessionIds.add(sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      { fs: capabilities },
      cwd
    );
  }

  async function executeRead(filePath: string, sessionId: string) {
    return readTool.execute(
      {
        file_path: filePath,
        encoding: 'utf8',
      },
      undefined,
      { sessionId }
    );
  }

  async function executeWrite(
    filePath: string,
    content: string,
    sessionId: string,
    options?: {
      encoding?: 'utf8' | 'base64' | 'binary';
      create_directories?: boolean;
      signal?: AbortSignal;
    }
  ) {
    return writeTool.execute(
      {
        file_path: filePath,
        content,
        encoding: options?.encoding ?? 'utf8',
        create_directories: options?.create_directories ?? true,
      },
      options?.signal,
      { sessionId }
    );
  }

  async function executeEdit(
    filePath: string,
    oldString: string,
    newString: string,
    sessionId: string,
    options?: { replace_all?: boolean; signal?: AbortSignal }
  ) {
    return editTool.execute(
      {
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
        replace_all: options?.replace_all ?? false,
      },
      options?.signal,
      { sessionId }
    );
  }

  async function expectRemoteReadSuccess(
    client: ControlledFileClient,
    filePath: string,
    sessionId: string,
    content: string
  ): Promise<void> {
    client.files.set(filePath, content);
    const result = await executeRead(filePath, sessionId);
    expect(result.success).toBe(true);
  }

  it('remote Write fails validation before any I/O when ACP client is read-only', async () => {
    const root = await createTempRoot('blade-acp-remote-write-capability-');
    const filePath = path.join(root, 'capability.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sessionId = 'remote-write-read-only';
    initializeRemoteSession(client, sessionId, root, { readTextFile: true });

    const result = await executeWrite(filePath, 'remote content\n', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(client.requests).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Edit fails validation before any I/O when ACP client is write-only', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-capability-');
    const filePath = path.join(root, 'capability.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'remote alpha\n');
    const sessionId = 'remote-edit-write-only';
    initializeRemoteSession(client, sessionId, root, { writeTextFile: true });

    const result = await executeEdit(filePath, 'alpha', 'beta', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(client.requests).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Write rejects non-utf8 encoding before any ACP request', async () => {
    const root = await createTempRoot('blade-acp-remote-write-encoding-');
    const filePath = path.join(root, 'encoding.bin');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sessionId = 'remote-write-non-utf8';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'aGVsbG8=', sessionId, {
      encoding: 'base64',
    });

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(client.requests).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Write of an existing file requires a prior successful remote Read', async () => {
    const root = await createTempRoot('blade-acp-remote-write-read-before-write-');
    const filePath = path.join(root, 'existing.txt');
    const hostCanary = 'host file must stay unchanged\n';
    const remoteContent = 'remote original\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, remoteContent);
    const sessionId = 'remote-write-needs-read';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'remote updated\n', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File not read before write');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Write sanitizes preflight read errors and keeps sentinel details out of the result', async () => {
    const root = await createTempRoot('blade-acp-remote-write-preflight-sanitize-');
    const filePath = path.join(root, 'sanitize.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sentinel = new RequestError(-32020, 'SENTINEL_PERMISSION');
    Object.assign(sentinel, {
      data: { sentinel: true },
      path: '/private/secret.txt',
    });
    client.enqueueReadError(sentinel);
    const sessionId = 'remote-write-preflight-sanitize';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'remote content\n', sessionId);

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'execution_error',
        message: 'Unable to read remote file before write',
      },
      metadata: {
        file_path: filePath,
        sideEffectsUncertain: false,
      },
    });
    expect(result.llmContent).toBe(
      'File write failed: Unable to read remote file before write'
    );
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PERMISSION');
    expect(JSON.stringify(result)).not.toContain('/private/secret.txt');
    expect(JSON.stringify(result)).not.toContain('"sentinel":true');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Edit of an existing file requires a prior successful remote Read', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-read-before-write-');
    const filePath = path.join(root, 'existing.txt');
    const hostCanary = 'host file must stay unchanged\n';
    const remoteContent = 'remote alpha\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, remoteContent);
    const sessionId = 'remote-edit-needs-read';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeEdit(filePath, 'alpha', 'beta', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File not read before edit');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Edit sanitizes preflight read errors and keeps sentinel details out of the result', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-preflight-sanitize-');
    const filePath = path.join(root, 'sanitize.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sentinel = new RequestError(-32021, 'SENTINEL_TIMEOUT');
    Object.assign(sentinel, {
      data: { sentinel: true },
      path: '/private/secret.txt',
    });
    client.enqueueReadError(sentinel);
    const sessionId = 'remote-edit-preflight-sanitize';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeEdit(filePath, 'alpha', 'beta', sessionId);

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'execution_error',
        message: 'Unable to read remote file before edit',
      },
      metadata: {
        file_path: filePath,
        sideEffectsUncertain: false,
      },
    });
    expect(result.llmContent).toBe(
      'File edit failed: Unable to read remote file before edit'
    );
    expect(JSON.stringify(result)).not.toContain('SENTINEL_TIMEOUT');
    expect(JSON.stringify(result)).not.toContain('/private/secret.txt');
    expect(JSON.stringify(result)).not.toContain('"sentinel":true');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Write rejects stale digests after a remote Read without issuing a write request', async () => {
    const root = await createTempRoot('blade-acp-remote-write-stale-');
    const filePath = path.join(root, 'stale.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha\n');
    const sessionId = 'remote-write-stale';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const readResult = await executeRead(filePath, sessionId);
    expect(readResult.success).toBe(true);
    client.files.set(filePath, 'beta\n');

    const result = await executeWrite(filePath, 'gamma\n', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File modified externally');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Edit rejects stale digests after a remote Read without issuing a write request', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-stale-');
    const filePath = path.join(root, 'stale.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha beta\n');
    const sessionId = 'remote-edit-stale';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const readResult = await executeRead(filePath, sessionId);
    expect(readResult.success).toBe(true);
    client.files.set(filePath, 'alpha gamma\n');

    const result = await executeEdit(filePath, 'beta', 'delta', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File modified externally');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Write currently does not report verified mutation metadata after an acknowledged write', async () => {
    const root = await createTempRoot('blade-acp-remote-write-metadata-');
    const filePath = path.join(root, 'metadata.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sessionId = 'remote-write-metadata';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'created remotely\n', sessionId);

    expect(result.success).toBe(true);
    expect(result.metadata?.write_acknowledged).toBe(true);
    expect(result.metadata?.write_verified).toBe(true);
    expect(result.metadata?.sideEffectsUncertain).toBe(false);
    expect(result.metadata?.snapshot_created).toBe(false);
    expect(result.metadata?.created_directories).toBeUndefined();
    expect(result.metadata?.last_modified).toBeUndefined();
    expect(result.metadata?.file_size).toBe(Buffer.byteLength('created remotely\n'));
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.getRemoteAccessRecord(filePath)?.lastOperation).toBe('write');
    expect(service.checkRemoteAccess(filePath, 'created remotely\n')).toBe('current');
  });

  it('remote Edit currently does not classify uncertain outcomes when write throws after applying remotely', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-uncertain-');
    const filePath = path.join(root, 'uncertain.txt');
    const hostCanary = 'host file must stay unchanged\n';
    const remoteContent = 'alpha beta\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, remoteContent);
    client.enqueueWriteBehavior({
      kind: 'apply-and-throw',
      error: new Error('remote ack lost'),
    });
    const sessionId = 'remote-edit-uncertain';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const readResult = await executeRead(filePath, sessionId);
    expect(readResult.success).toBe(true);

    const result = await executeEdit(filePath, 'beta', 'gamma', sessionId);

    expect(result.success).toBe(true);
    expect(result.metadata?.write_acknowledged).toBe(false);
    expect(result.metadata?.write_verified).toBe(true);
    expect(result.metadata?.sideEffectsUncertain).toBe(false);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(service.getRemoteAccessRecord(filePath)?.lastOperation).toBe('edit');
    expect(service.checkRemoteAccess(filePath, 'alpha gamma\n')).toBe('current');
  });

  it('remote Write fails validation before any I/O when ACP client is write-only', async () => {
    const root = await createTempRoot('blade-acp-remote-write-write-only-');
    const filePath = path.join(root, 'capability.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    const sessionId = 'remote-write-write-only';
    initializeRemoteSession(client, sessionId, root, { writeTextFile: true });

    const result = await executeWrite(filePath, 'remote content\n', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(client.requests).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Edit fails validation before any I/O when ACP client is read-only', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-read-only-');
    const filePath = path.join(root, 'capability.txt');
    const hostCanary = 'host file must stay unchanged\n';
    await fs.writeFile(filePath, hostCanary, 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'remote alpha\n');
    const sessionId = 'remote-edit-read-only';
    initializeRemoteSession(client, sessionId, root, { readTextFile: true });

    const result = await executeEdit(filePath, 'alpha', 'beta', sessionId);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(client.requests).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
  });

  it('remote Write on a missing file succeeds without a prior Read and does not touch host parent state', async () => {
    const root = await createTempRoot('blade-acp-remote-write-missing-');
    const filePath = path.join(root, 'nested', 'created.txt');
    const parentDir = path.dirname(filePath);
    const client = new ControlledFileClient();
    const sessionId = 'remote-write-missing';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'created remotely\n', sessionId, {
      create_directories: true,
    });

    expect(result.success).toBe(true);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'write',
        request: {
          path: filePath,
          content: 'created remotely\n',
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
    await expect(fs.access(parentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
  });

  it('remote Edit on a missing file maps to not-found without issuing a write request', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-missing-');
    const filePath = path.join(root, 'missing.txt');
    const client = new ControlledFileClient();
    const sessionId = 'remote-edit-missing';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeEdit(filePath, 'alpha', 'beta', sessionId);

    expect(result.success).toBe(false);
    expect(result.llmContent).toBe(`File not found: ${filePath}`);
    expect(result.error?.type).toBe('execution_error');
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Write does not accept a prior Read from another session on the same path', async () => {
    const root = await createTempRoot('blade-acp-remote-write-cross-session-');
    const filePath = path.join(root, 'shared.txt');
    const clientA = new ControlledFileClient();
    const clientB = new ControlledFileClient();
    const sessionA = 'remote-write-cross-session-a';
    const sessionB = 'remote-write-cross-session-b';

    initializeRemoteSession(clientA, sessionA, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    initializeRemoteSession(clientB, sessionB, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(clientA, filePath, sessionA, 'alpha\n');
    clientB.files.set(filePath, 'alpha\n');

    const result = await executeWrite(filePath, 'beta\n', sessionB);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File not read before write');
    expect(clientB.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId: sessionB,
        },
      },
    ]);
  });

  it('remote Edit does not accept a prior Read from another session on the same path', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-cross-session-');
    const filePath = path.join(root, 'shared.txt');
    const clientA = new ControlledFileClient();
    const clientB = new ControlledFileClient();
    const sessionA = 'remote-edit-cross-session-a';
    const sessionB = 'remote-edit-cross-session-b';

    initializeRemoteSession(clientA, sessionA, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    initializeRemoteSession(clientB, sessionB, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(clientA, filePath, sessionA, 'alpha beta\n');
    clientB.files.set(filePath, 'alpha beta\n');

    const result = await executeEdit(filePath, 'beta', 'gamma', sessionB);

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.message).toBe('File not read before edit');
    expect(clientB.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId: sessionB,
        },
      },
    ]);
  });

  it('remote Write permits mutation when the prior digest is unchanged', async () => {
    const root = await createTempRoot('blade-acp-remote-write-current-');
    const filePath = path.join(root, 'current.txt');
    const client = new ControlledFileClient();
    const sessionId = 'remote-write-current';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(client, filePath, sessionId, 'alpha\n');
    const result = await executeWrite(filePath, 'beta\n', sessionId);

    expect(result.success).toBe(true);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'write',
        request: {
          path: filePath,
          content: 'beta\n',
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it('remote Edit permits mutation when the prior digest is unchanged', async () => {
    const root = await createTempRoot('blade-acp-remote-edit-current-');
    const filePath = path.join(root, 'current.txt');
    const client = new ControlledFileClient();
    const sessionId = 'remote-edit-current';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(client, filePath, sessionId, 'alpha beta\n');
    const result = await executeEdit(filePath, 'beta', 'gamma', sessionId);

    expect(result.success).toBe(true);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
      {
        kind: 'write',
        request: {
          path: filePath,
          content: 'alpha gamma\n',
          sessionId,
        },
      },
      {
        kind: 'read',
        request: {
          path: filePath,
          sessionId,
        },
      },
    ]);
  });

  it.each([
    {
      label: 'acknowledged success',
      configure: (_client: ControlledFileClient) => {
        // no-op
      },
      expected: {
        success: true,
        write_acknowledged: true,
        write_verified: true,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'ack lost but readback intended',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'apply-and-throw',
          error: new Error('ack lost'),
        });
      },
      expected: {
        success: true,
        write_acknowledged: false,
        write_verified: true,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'acknowledged old content readback',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({ kind: 'ack-without-apply' });
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'acknowledged third content readback',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'ack-with-replacement',
          content: 'third value\n',
        });
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'old content after thrown write',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'leave-old-and-throw',
          error: new Error('write rejected'),
        });
      },
      expected: {
        success: false,
        write_acknowledged: false,
        write_verified: false,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'third content after thrown write',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'replace-and-throw',
          content: 'third value\n',
          error: new Error('write ambiguous'),
        });
      },
      expected: {
        success: false,
        write_acknowledged: false,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback permission error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new RequestError(-32020, 'Permission denied'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback timeout error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new RequestError(-32021, 'Request timed out'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback disconnect error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(
          1,
          new RequestError(-32022, 'Network disconnected')
        );
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback unknown error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new Error('Unexpected decode failure'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
  ])('remote Write outcome matrix: $label', async ({ configure, expected }) => {
    const root = await createTempRoot('blade-acp-remote-write-matrix-');
    const filePath = path.join(root, 'matrix.txt');
    const client = new ControlledFileClient();
    const sessionId = `remote-write-matrix-${Math.random().toString(16).slice(2)}`;
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(client, filePath, sessionId, 'alpha\n');
    configure(client);

    const result = await executeWrite(filePath, 'beta\n', sessionId);

    expect(result.success).toBe(expected.success);
    expect(result.metadata?.write_acknowledged).toBe(expected.write_acknowledged);
    expect(result.metadata?.write_verified).toBe(expected.write_verified);
    expect(result.metadata?.sideEffectsUncertain).toBe(expected.sideEffectsUncertain);
    expect(client.requests.map((request) => request.kind)).toEqual([
      'read',
      'read',
      'write',
      'read',
    ]);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    if (expected.success) {
      expect(service.getRemoteAccessRecord(filePath)?.lastOperation).toBe('write');
      expect(service.checkRemoteAccess(filePath, 'beta\n')).toBe('current');
    } else {
      expect(service.checkRemoteAccess(filePath, 'alpha\n')).toBe('current');
      expect(service.checkRemoteAccess(filePath, 'beta\n')).not.toBe('current');
    }
  });

  it('remote Write classifies new file still missing after a thrown write as definite failure', async () => {
    const root = await createTempRoot('blade-acp-remote-write-new-not-found-');
    const filePath = path.join(root, 'new-file.txt');
    const client = new ControlledFileClient();
    client.enqueueWriteBehavior({
      kind: 'leave-old-and-throw',
      error: new Error('write rejected'),
    });
    const sessionId = 'remote-write-new-not-found';
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const result = await executeWrite(filePath, 'created remotely\n', sessionId);

    expect(result.success).toBe(false);
    expect(result.metadata?.write_acknowledged).toBe(false);
    expect(result.metadata?.write_verified).toBe(false);
    expect(result.metadata?.sideEffectsUncertain).toBe(false);
  });

  it('remote Write times out readback after exactly 5s and does not replay the write', async () => {
    vi.useFakeTimers();
    let releaseBlockedRead: (() => void) | undefined;
    try {
      const root = await createTempRoot('blade-acp-remote-write-readback-timeout-');
      const filePath = path.join(root, 'timeout.txt');
      const client = new ControlledFileClient();
      client.enqueueReadPassThrough();
      const blockedRead = client.enqueueBlockedRead();
      releaseBlockedRead = blockedRead.release;
      const sessionId = 'remote-write-readback-timeout';
      initializeRemoteSession(client, sessionId, root, {
        readTextFile: true,
        writeTextFile: true,
      });

      const resultPromise = executeWrite(filePath, 'created remotely\n', sessionId);
      await Promise.resolve();

      let settled = false;
      void resultPromise.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toMatchObject({
        success: false,
        error: {
          type: 'execution_error',
        },
        metadata: {
          write_acknowledged: true,
          write_verified: false,
          sideEffectsUncertain: true,
        },
      });
      expect(result.llmContent).toContain(
        'write readback could not verify the remote side effects'
      );
      expect(client.requests.map((request) => request.kind)).toEqual([
        'read',
        'write',
        'read',
      ]);
    } finally {
      releaseBlockedRead?.();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: 'acknowledged success',
      configure: (_client: ControlledFileClient) => {
        // no-op
      },
      expected: {
        success: true,
        write_acknowledged: true,
        write_verified: true,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'ack lost but readback intended',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'apply-and-throw',
          error: new Error('ack lost'),
        });
      },
      expected: {
        success: true,
        write_acknowledged: false,
        write_verified: true,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'acknowledged old content readback',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({ kind: 'ack-without-apply' });
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'acknowledged third content readback',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'ack-with-replacement',
          content: 'alpha third\n',
        });
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'old content after thrown write',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'leave-old-and-throw',
          error: new Error('write rejected'),
        });
      },
      expected: {
        success: false,
        write_acknowledged: false,
        write_verified: false,
        sideEffectsUncertain: false,
      },
    },
    {
      label: 'third content after thrown write',
      configure: (client: ControlledFileClient) => {
        client.enqueueWriteBehavior({
          kind: 'replace-and-throw',
          content: 'alpha third\n',
          error: new Error('write ambiguous'),
        });
      },
      expected: {
        success: false,
        write_acknowledged: false,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback disconnect error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(
          1,
          new RequestError(-32022, 'Network disconnected')
        );
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback permission error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new RequestError(-32020, 'Permission denied'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback timeout error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new RequestError(-32021, 'Request timed out'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
    {
      label: 'readback unknown error',
      configure: (client: ControlledFileClient) => {
        client.enqueueReadErrorAfter(1, new Error('Unexpected decode failure'));
      },
      expected: {
        success: false,
        write_acknowledged: true,
        write_verified: false,
        sideEffectsUncertain: true,
      },
    },
  ])('remote Edit outcome matrix: $label', async ({ configure, expected }) => {
    const root = await createTempRoot('blade-acp-remote-edit-matrix-');
    const filePath = path.join(root, 'matrix.txt');
    const client = new ControlledFileClient();
    const sessionId = `remote-edit-matrix-${Math.random().toString(16).slice(2)}`;
    initializeRemoteSession(client, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });

    await expectRemoteReadSuccess(client, filePath, sessionId, 'alpha beta\n');
    configure(client);

    const result = await executeEdit(filePath, 'beta', 'gamma', sessionId);

    expect(result.success).toBe(expected.success);
    expect(result.metadata?.write_acknowledged).toBe(expected.write_acknowledged);
    expect(result.metadata?.write_verified).toBe(expected.write_verified);
    expect(result.metadata?.sideEffectsUncertain).toBe(expected.sideEffectsUncertain);
    expect(client.requests.map((request) => request.kind)).toEqual([
      'read',
      'read',
      'write',
      'read',
    ]);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    if (expected.success) {
      expect(service.getRemoteAccessRecord(filePath)?.lastOperation).toBe('edit');
      expect(service.checkRemoteAccess(filePath, 'alpha gamma\n')).toBe('current');
    } else {
      expect(service.checkRemoteAccess(filePath, 'alpha beta\n')).toBe('current');
      expect(service.checkRemoteAccess(filePath, 'alpha gamma\n')).not.toBe('current');
    }
  });
});
