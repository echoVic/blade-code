import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUserPromptArtifactReference,
  UserPromptArtifactStore,
} from '../../../../../src/agent/runtime/UserPromptArtifactStore.js';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../../../src/api/attachmentLimits.js';
import { createReadPromptArtifactTool } from '../../../../../src/tools/builtin/system/readPromptArtifact.js';
import { executeToolInvocation } from '../../../../../src/tools/execution/ToolInvocationRunner.js';

describe('ReadPromptArtifact', () => {
  let storageRoot: string;
  let store: UserPromptArtifactStore;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-read-prompt-'));
    store = new UserPromptArtifactStore(
      path.join(storageRoot, 'workspace'),
      'prompt-session',
      { storageRoot }
    );
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('reads bounded chunks without exposing a host path', async () => {
    const full = `${'a'.repeat(MAX_INLINE_USER_MESSAGE_TEXT_BYTES)}SECRET_TAIL`;
    const materialized = await store.materialize(full);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;
    const tool = createReadPromptArtifactTool(store);

    const first = await tool.execute(
      { artifact_id: reference.id, offset: 0, limit: 1024 },
      new AbortController().signal
    );
    expect(first).toMatchObject({
      success: true,
      metadata: {
        artifact_id: reference.id,
        offset: 0,
        returned_bytes: 1024,
        next_offset: 1024,
      },
    });
    expect(first.llmContent).toContain('[Continue with offset=1024]');
    expect(JSON.stringify(first)).not.toContain(storageRoot);

    const last = await tool.execute(
      {
        artifact_id: reference.id,
        offset: reference.sizeBytes - Buffer.byteLength('SECRET_TAIL'),
        limit: 1024,
      },
      new AbortController().signal
    );
    expect(last.llmContent).toContain('SECRET_TAIL');
    expect(last.llmContent).toContain('[End of prompt artifact]');
  });

  it('returns a bounded execution error for an unavailable artifact', async () => {
    const tool = createReadPromptArtifactTool(store);
    const result = await tool.execute(
      { artifact_id: '0'.repeat(64), offset: 0, limit: 1024 },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'execution_error',
      },
      metadata: {
        summary: 'Prompt artifact read failed',
      },
    });
    expect(String(result.llmContent)).not.toContain(storageRoot);
  });

  it('retries a transient store read without exposing its internal message', async () => {
    const artifactId = '1'.repeat(64);
    const read = vi
      .spyOn(store, 'read')
      .mockRejectedValueOnce(
        Object.assign(new Error(`EMFILE: ${storageRoot}/private.txt`), {
          code: 'EMFILE',
        })
      )
      .mockResolvedValueOnce({
        id: artifactId,
        sha256: artifactId,
        sizeBytes: 2,
        offset: 0,
        returnedBytes: 2,
        content: 'ok',
      });
    const tool = createReadPromptArtifactTool(store);

    const result = await executeToolInvocation(
      tool.build({ artifact_id: artifactId, offset: 0, limit: 1024 }),
      {}
    );

    expect(result).toMatchObject({
      success: true,
      llmContent: 'ok\n\n[End of prompt artifact]',
      metadata: { retriedAttempts: 1 },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(storageRoot);
  });
});
