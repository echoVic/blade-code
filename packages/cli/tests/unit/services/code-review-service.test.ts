import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { CodeReviewService } from '../../../src/services/CodeReviewService.js';
import { GitReviewTargetService } from '../../../src/services/GitReviewTargetService.js';
import { SessionService } from '../../../src/services/SessionService.js';

const executeReview = vi.hoisted(() => vi.fn());

vi.unmock('node:child_process');

vi.mock('../../../src/agent/subagents/SubagentExecutor.js', () => ({
  SubagentExecutor: class {
    execute = executeReview;
  },
}));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function reviewerOutput() {
  return {
    success: true,
    message: JSON.stringify({
      overall_explanation: 'The changed fallback is unsafe.',
      findings: [
        {
          title: '[P1] Preserve the null guard',
          body: 'The new branch dereferences input when it can be null.',
          priority: 1,
          confidence_score: 0.97,
          code_location: {
            path: 'tracked.ts',
            line_start: 1,
            line_end: 1,
          },
        },
      ],
    }),
    modifiedFiles: [],
    messages: [],
    stats: { duration: 10 },
  };
}

describe('CodeReviewService', () => {
  let storageRoot: string;
  let workspace: string;
  let sessionId: string;
  let runtime: SessionRuntime;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-review-storage-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-review-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'review@example.com']);
    git(workspace, ['config', 'user.name', 'Review Test']);
    await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 1;\n');
    git(workspace, ['add', 'tracked.ts']);
    git(workspace, ['commit', '-qm', 'baseline']);
    await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 2;\n');
    sessionId = 'review-parent';
    await SessionService.createSessionMetadata(sessionId, workspace, {
      taskStatus: 'completed',
    });
    runtime = {
      sessionId,
      workspaceRoot: workspace,
      hasTurnOwner: () => false,
      getAgentResources: () => ({}) as never,
      getModelResources: () => ({}) as never,
      getLspResources: () => ({}) as never,
      getCurrentModelId: () => 'model-1',
      getReasoningConfiguration: () => ({ selection: 'auto' }) as never,
      getServiceTierConfiguration: () => ({ selection: 'standard' }) as never,
      getResponseVerbosityConfiguration: () => ({ selection: 'medium' }) as never,
      getCommunicationStyleConfiguration: () => ({ selection: 'auto' }) as never,
    } as unknown as SessionRuntime;
    executeReview.mockReset();
    executeReview.mockResolvedValue(reviewerOutput());
  });

  afterEach(async () => {
    delete process.env.BLADE_STORAGE_ROOT;
    vi.restoreAllMocks();
    await rm(storageRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('persists start before completion and materializes a structured report', async () => {
    const run = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });
    const completion = await run.completion;
    const events = await new JSONLStore(
      getSessionFilePath(workspace, sessionId)
    ).readAll();
    const startIndex = events.findIndex((event) => event.type === 'review_started');
    const completionIndex = events.findIndex(
      (event) => event.type === 'review_completed'
    );

    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(startIndex);
    expect(completion).toMatchObject({
      status: 'completed',
      findings: [
        {
          priority: 1,
          confidenceScore: 0.97,
          codeLocation: { path: 'tracked.ts', lineStart: 1, lineEnd: 1 },
        },
      ],
    });
    const transcript = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
    expect(transcript).toContain('## Code Review');
    expect(transcript).toContain('[P1] Preserve the null guard');
    expect(transcript).toContain('/review uncommitted');
    expect(transcript).not.toContain('/review uncommitted changes');
  });

  it('marks the report stale when the target changes during review', async () => {
    executeReview.mockImplementationOnce(async () => {
      await writeFile(path.join(workspace, 'tracked.ts'), 'export const value = 3;\n');
      return reviewerOutput();
    });
    const run = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });

    await expect(run.completion).resolves.toMatchObject({ status: 'stale' });
  });

  it('allows only one active review and persists an abort terminal state', async () => {
    const controller = new AbortController();
    executeReview.mockImplementationOnce(async (context: { signal?: AbortSignal }) => {
      if (!context.signal?.aborted) {
        await new Promise<void>((resolve) =>
          context.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          })
        );
      }
      return {
        ...reviewerOutput(),
        success: false,
        error: 'aborted',
      };
    });
    const run = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
      signal: controller.signal,
    });

    await expect(
      CodeReviewService.start({
        sessionId,
        projectPath: workspace,
        runtime,
        request: { kind: 'uncommitted' },
      })
    ).rejects.toThrow('active review');
    controller.abort();
    await expect(run.completion).resolves.toMatchObject({
      status: 'aborted',
      findings: [],
    });
    await expect(CodeReviewService.list(workspace, sessionId)).resolves.toEqual([
      expect.objectContaining({
        completion: expect.objectContaining({ status: 'aborted' }),
      }),
    ]);
    await expect(
      SessionService.findSessionMetadata(sessionId, workspace)
    ).resolves.toMatchObject({
      taskStatus: 'cancelled',
    });
  });

  it('fails closed on malformed model output', async () => {
    executeReview.mockResolvedValueOnce({
      ...reviewerOutput(),
      message: 'not structured output',
    });
    const run = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });

    await expect(run.completion).resolves.toMatchObject({
      status: 'failed',
      findings: [],
    });
  });

  it('rejects findings outside the reviewed diff hunk', async () => {
    const output = reviewerOutput();
    const parsed = JSON.parse(output.message) as {
      findings: Array<{
        code_location: { line_start: number; line_end: number };
      }>;
    };
    parsed.findings[0]!.code_location = {
      ...parsed.findings[0]!.code_location,
      line_start: 100,
      line_end: 100,
    };
    executeReview.mockResolvedValueOnce({
      ...output,
      message: JSON.stringify(parsed),
    });

    const run = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });

    await expect(run.completion).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('does not overlap'),
    });
  });

  it('rejects inconsistent priority labels and ranges over 10 lines', async () => {
    const mismatched = reviewerOutput();
    const mismatchedReport = JSON.parse(mismatched.message) as {
      findings: Array<{ title: string }>;
    };
    mismatchedReport.findings[0]!.title = '[P0] Preserve the null guard';
    executeReview.mockResolvedValueOnce({
      ...mismatched,
      message: JSON.stringify(mismatchedReport),
    });
    const mismatchedRun = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });
    await expect(mismatchedRun.completion).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('priority does not match'),
    });

    const oversized = reviewerOutput();
    const oversizedReport = JSON.parse(oversized.message) as {
      findings: Array<{
        code_location: { line_start: number; line_end: number };
      }>;
    };
    oversizedReport.findings[0]!.code_location.line_end = 11;
    executeReview.mockResolvedValueOnce({
      ...oversized,
      message: JSON.stringify(oversizedReport),
    });
    const oversizedRun = await CodeReviewService.start({
      sessionId,
      projectPath: workspace,
      runtime,
      request: { kind: 'uncommitted' },
    });
    await expect(oversizedRun.completion).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('line range is invalid'),
    });
  });

  it('closes an interrupted review without replaying it', async () => {
    const target = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });
    const store = new PersistentStore(workspace);
    await store.saveReviewStart(sessionId, {
      reviewId: 'interrupted-review',
      reviewerSessionId: 'review-child',
      target: target.info,
      startedAt: new Date().toISOString(),
    });

    const completion = await CodeReviewService.recoverInterrupted(
      workspace,
      sessionId,
      runtime
    );

    expect(completion).toMatchObject({
      reviewId: 'interrupted-review',
      status: 'interrupted',
    });
    expect(executeReview).not.toHaveBeenCalled();
  });

  it('projects a completed report when the post-event message write was lost', async () => {
    const crashSessionId = 'review-completion-crash';
    await SessionService.createSessionMetadata(crashSessionId, workspace, {
      taskStatus: 'completed',
    });
    const target = await GitReviewTargetService.resolve(workspace, {
      kind: 'uncommitted',
    });
    const store = new PersistentStore(workspace);
    await store.saveReviewStart(crashSessionId, {
      reviewId: 'durable-review',
      reviewerSessionId: 'durable-review-child',
      target: target.info,
      startedAt: '2026-08-11T00:00:00.000Z',
    });
    await expect(
      SessionService.findSessionMetadata(crashSessionId, workspace)
    ).resolves.toMatchObject({
      taskStatus: 'running',
      taskPromptSummary: '/review uncommitted',
    });
    await store.saveReviewCompletion(crashSessionId, {
      reviewId: 'durable-review',
      status: 'completed',
      overallExplanation: 'Recovered from the completion event.',
      findings: [],
      completedAt: '2026-08-11T00:00:01.000Z',
    });

    const messages = await SessionService.loadSession(crashSessionId, workspace);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Recovered from the completion event.'),
        metadata: {
          codeReview: expect.objectContaining({
            reviewId: 'durable-review',
            synthetic: true,
          }),
        },
      })
    );
    await expect(
      SessionService.findSessionMetadata(crashSessionId, workspace)
    ).resolves.toMatchObject({
      taskStatus: 'completed',
      taskCompletedAt: '2026-08-11T00:00:01.000Z',
    });
  });
});
