import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getUserPromptArtifactReference,
  UserPromptArtifactStore,
} from '../../../../../src/agent/runtime/UserPromptArtifactStore.js';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../../../src/api/attachmentLimits.js';
import { createReadPromptArtifactTool } from '../../../../../src/tools/builtin/system/readPromptArtifact.js';

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
});
