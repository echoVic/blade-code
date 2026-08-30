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
import { FileAccessTracker } from '../../src/tools/builtin/file/FileAccessTracker.js';
import { readTool } from '../../src/tools/builtin/file/read.js';
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
