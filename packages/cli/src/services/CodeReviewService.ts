import path from 'node:path';
import { nanoid } from 'nanoid';
import type { LoopEvent } from '../agent/loop/types.js';
import { SessionRuntime } from '../agent/runtime/SessionRuntime.js';
import { reviewAgentConfig } from '../agent/subagents/builtinReviewAgent.js';
import { SubagentExecutor } from '../agent/subagents/SubagentExecutor.js';
import { PermissionMode } from '../config/types.js';
import {
  codeReviewMessageMetadata,
  findPendingSessionReview,
  projectSessionReviews,
  renderCodeReview,
  renderReviewStatus,
} from '../context/reviews.js';
import { JSONLStore } from '../context/storage/JSONLStore.js';
import { PersistentStore } from '../context/storage/PersistentStore.js';
import { getSessionFilePath } from '../context/storage/pathUtils.js';
import type {
  SessionReviewCompletionInfo,
  SessionReviewFinding,
  SessionReviewStartInfo,
} from '../context/types.js';
import { createSessionId } from '../utils/sessionId.js';
import {
  type CodeReviewTargetRequest,
  GitReviewTargetService,
  type ResolvedCodeReviewTarget,
} from './GitReviewTargetService.js';
import { SessionService } from './SessionService.js';

export { renderCodeReview };

const MAX_REVIEW_OUTPUT_BYTES = 128 * 1024;
const MAX_REVIEW_FINDINGS = 50;
const runningReviews = new Set<string>();

export interface CodeReviewRequest extends CodeReviewTargetRequest {
  instructions?: string;
}

export interface CodeReviewRun {
  reviewId: string;
  completion: Promise<SessionReviewCompletionInfo>;
}

export interface StartCodeReviewOptions {
  sessionId: string;
  projectPath: string;
  runtime: SessionRuntime;
  request: CodeReviewRequest;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void | Promise<void>;
}

function reviewKey(projectPath: string, sessionId: string): string {
  return `${path.resolve(projectPath)}\0${sessionId}`;
}

function reviewPrompt(request: CodeReviewRequest): string {
  return `/review ${request.kind}${
    request.kind === 'uncommitted' ? '' : ` ${request.ref?.trim() ?? ''}`
  }`;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength) {
    throw new Error(`${label} exceeds its allowed length`);
  }
  return normalized;
}

function normalizeFinding(
  value: unknown,
  workspaceRoot: string,
  target: ResolvedCodeReviewTarget
): SessionReviewFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review finding must be an object');
  }
  const finding = value as Record<string, unknown>;
  const legacyLine =
    typeof finding.line === 'number' && Number.isInteger(finding.line)
      ? finding.line
      : undefined;
  const location =
    finding.code_location ??
    (typeof finding.file === 'string' && legacyLine !== undefined
      ? {
          path: finding.file,
          line_start: legacyLine,
          line_end: legacyLine,
        }
      : undefined);
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    throw new Error('Review finding has no code_location');
  }
  const codeLocation = location as Record<string, unknown>;
  const rawPath = boundedString(codeLocation.path, 'Finding path', 1_000);
  const normalizedPath = path.posix.normalize(rawPath.replaceAll('\\', '/'));
  if (
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error('Review finding path must be workspace-relative');
  }
  const resolved = path.resolve(workspaceRoot, normalizedPath);
  const relative = path.relative(path.resolve(workspaceRoot), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Review finding path escapes the workspace');
  }

  const severity =
    typeof finding.severity === 'string' ? finding.severity.toLowerCase() : '';
  const inferredPriority =
    severity === 'critical'
      ? 0
      : severity === 'high'
        ? 1
        : severity === 'medium'
          ? 2
          : severity === 'low'
            ? 3
            : undefined;
  const priority = finding.priority ?? inferredPriority;
  if (priority !== 0 && priority !== 1 && priority !== 2 && priority !== 3) {
    throw new Error('Review finding priority must be 0-3');
  }
  const confidence = finding.confidence_score ?? finding.confidence ?? 0.8;
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error('Review finding confidence_score must be between 0 and 1');
  }
  const lineStart = codeLocation.line_start;
  const lineEnd = codeLocation.line_end;
  if (
    !Number.isInteger(lineStart) ||
    !Number.isInteger(lineEnd) ||
    (lineStart as number) < 1 ||
    (lineEnd as number) < (lineStart as number) ||
    (lineEnd as number) - (lineStart as number) >= 10
  ) {
    throw new Error('Review finding line range is invalid');
  }
  const ranges = target.changedLines.get(normalizedPath);
  if (!ranges) {
    throw new Error('Review finding path is outside the review target');
  }
  if (
    !ranges.some(
      (range) =>
        (lineStart as number) <= range.end && (lineEnd as number) >= range.start
    )
  ) {
    throw new Error('Review finding line range does not overlap the changed lines');
  }

  const title = boundedString(
    finding.title ??
      `[P${priority}] ${String(finding.type ?? 'Review finding')
        .replaceAll('-', ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase())}`,
    'Finding title',
    120
  );
  if (!title.startsWith(`[P${priority}] `)) {
    throw new Error('Review finding title priority does not match priority');
  }

  return {
    title,
    body: boundedString(finding.body ?? finding.description, 'Finding body', 4_000),
    priority,
    confidenceScore: confidence,
    codeLocation: {
      path: normalizedPath,
      lineStart: lineStart as number,
      lineEnd: lineEnd as number,
    },
  };
}

function parseReviewOutput(
  output: string,
  workspaceRoot: string,
  target: ResolvedCodeReviewTarget
): Pick<SessionReviewCompletionInfo, 'overallExplanation' | 'findings'> {
  if (Buffer.byteLength(output) > MAX_REVIEW_OUTPUT_BYTES) {
    throw new Error('Review output exceeds the 128 KiB limit');
  }
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Reviewer did not return a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error('Reviewer returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Reviewer output must be an object');
  }
  const report = parsed as Record<string, unknown>;
  if (!Array.isArray(report.findings)) {
    throw new Error('Reviewer output must contain findings');
  }
  if (report.findings.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`Reviewer returned more than ${MAX_REVIEW_FINDINGS} findings`);
  }
  return {
    overallExplanation: boundedString(
      report.overall_explanation ?? report.summary,
      'Review explanation',
      10_000,
      true
    ),
    findings: report.findings.map((finding) =>
      normalizeFinding(finding, workspaceRoot, target)
    ),
  };
}

async function readEvents(projectPath: string, sessionId: string) {
  return new JSONLStore(getSessionFilePath(projectPath, sessionId)).readAll();
}

export class CodeReviewService {
  static async start(options: StartCodeReviewOptions): Promise<CodeReviewRun> {
    const { sessionId, projectPath, runtime, request, onEvent } = options;
    if (
      runtime.sessionId !== sessionId ||
      path.resolve(runtime.workspaceRoot) !== path.resolve(projectPath)
    ) {
      throw new Error('Review runtime does not own the requested Session');
    }
    if (runtime.hasTurnOwner()) {
      throw new Error('Cannot start a review during an active turn');
    }
    await SessionService.assertSessionWritable(sessionId, projectPath);
    const key = reviewKey(projectPath, sessionId);
    if (runningReviews.has(key)) {
      throw new Error('Session already has an active review');
    }
    const events = await readEvents(projectPath, sessionId);
    if (findPendingSessionReview(events)) {
      throw new Error('Session has an interrupted review that must be recovered');
    }
    const instructions = request.instructions?.trim();
    if (instructions && instructions.length > 4_000) {
      throw new Error('Review instructions exceed 4,000 characters');
    }
    const target = await GitReviewTargetService.resolve(projectPath, request);
    const reviewId = nanoid(16);
    const reviewerSessionId = createSessionId('review');
    const startedAt = new Date().toISOString();
    const start: SessionReviewStartInfo = {
      reviewId,
      reviewerSessionId,
      target: target.info,
      startedAt,
    };
    const store = new PersistentStore(projectPath);
    await store.saveReviewStart(sessionId, start);
    await store.saveMessage(sessionId, 'user', reviewPrompt(request), null, {
      codeReview: {
        reviewId,
        phase: 'started',
        targetKind: target.info.kind,
        targetDigest: target.info.digest,
      },
    });
    await SessionService.updateSessionMetadata(sessionId, projectPath, {
      taskStatus: 'running',
      taskStatusReason: `Reviewing ${target.info.label}`,
      taskPromptSummary: reviewPrompt(request),
      taskStartedAt: startedAt,
      taskCompletedAt: null,
      taskFailure: null,
    });

    runningReviews.add(key);
    const completion = this.execute({
      ...options,
      target,
      reviewId,
      reviewerSessionId,
      instructions,
      store,
      onEvent,
    }).finally(() => {
      runningReviews.delete(key);
    });
    return { reviewId, completion };
  }

  private static async execute(
    options: StartCodeReviewOptions & {
      target: Awaited<ReturnType<typeof GitReviewTargetService.resolve>>;
      reviewId: string;
      reviewerSessionId: string;
      instructions?: string;
      store: PersistentStore;
    }
  ): Promise<SessionReviewCompletionInfo> {
    const {
      sessionId,
      projectPath,
      runtime,
      request,
      signal,
      onEvent,
      target,
      reviewId,
      reviewerSessionId,
      instructions,
      store,
    } = options;
    let completion: SessionReviewCompletionInfo;
    try {
      const prompt = [
        target.instruction,
        'Bash already starts in the review workspace. Never prefix a command with cd.',
        `Authoritative target digest: ${target.info.digest}`,
        `Changed file count: ${target.info.fileCount}`,
        instructions ? `Additional review instructions:\n${instructions}` : '',
        'Inspect the diff and enough surrounding code to prove each finding.',
        'Return only JSON with keys overall_explanation and findings. Each finding',
        'must use title, body, priority, confidence_score, and code_location',
        '(path, line_start, line_end) exactly as defined by the reviewer contract.',
      ]
        .filter(Boolean)
        .join('\n\n');
      const executor = new SubagentExecutor(
        reviewAgentConfig,
        runtime.getAgentResources(),
        runtime.getModelResources(),
        runtime.getLspResources()
      );
      const result = await executor.execute({
        prompt,
        parentSessionId: sessionId,
        modelId: runtime.getCurrentModelId(),
        permissionMode: PermissionMode.DEFAULT,
        reasoningEffort: runtime.getReasoningConfiguration().selection,
        serviceTier: runtime.getServiceTierConfiguration().selection,
        responseVerbosity: runtime.getResponseVerbosityConfiguration().selection,
        communicationStyle: runtime.getCommunicationStyleConfiguration().selection,
        subagentSessionId: reviewerSessionId,
        workspaceRoot: projectPath,
        signal,
        onEvent,
      });
      if (!result.success) {
        throw new Error(result.error || 'Review agent failed');
      }
      if ((result.modifiedFiles?.length ?? 0) > 0) {
        throw new Error('Read-only reviewer reported workspace modifications');
      }
      const report = parseReviewOutput(result.message, projectPath, target);
      let stale = false;
      try {
        const current = await GitReviewTargetService.resolve(projectPath, request);
        stale = current.info.digest !== target.info.digest;
      } catch {
        stale = true;
      }
      completion = {
        reviewId,
        status: stale ? 'stale' : 'completed',
        ...report,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const aborted = signal?.aborted === true;
      completion = {
        reviewId,
        status: aborted ? 'aborted' : 'failed',
        overallExplanation: aborted
          ? 'The code review was aborted.'
          : 'The code review could not produce a valid structured report.',
        findings: [],
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
      };
    }

    await store.saveReviewCompletion(sessionId, completion);
    const start = projectSessionReviews(await readEvents(projectPath, sessionId)).find(
      (review) => review.start.reviewId === reviewId
    )?.start;
    if (!start) throw new Error(`Review start disappeared: ${reviewId}`);
    await store.saveMessage(
      sessionId,
      'assistant',
      renderCodeReview(start, completion),
      null,
      {
        codeReview: codeReviewMessageMetadata(start, completion),
      }
    );
    await SessionService.updateSessionMetadata(sessionId, projectPath, {
      taskStatus:
        completion.status === 'completed' || completion.status === 'stale'
          ? 'completed'
          : completion.status === 'aborted'
            ? 'cancelled'
            : completion.status === 'interrupted'
              ? 'interrupted'
              : 'failed',
      taskStatusReason:
        completion.status === 'completed'
          ? null
          : `Code review ${renderReviewStatus(completion.status)}`,
      taskCompletedAt: completion.completedAt,
      taskOwnerPid: null,
    });
    return completion;
  }

  static async recoverInterrupted(
    projectPath: string,
    sessionId: string,
    runtime: SessionRuntime
  ): Promise<SessionReviewCompletionInfo | undefined> {
    const key = reviewKey(projectPath, sessionId);
    if (runningReviews.has(key)) return undefined;
    const events = await readEvents(projectPath, sessionId);
    const pending = findPendingSessionReview(events);
    if (!pending) return undefined;
    if (
      runtime.sessionId !== sessionId ||
      path.resolve(runtime.workspaceRoot) !== path.resolve(projectPath)
    ) {
      throw new Error('Review recovery requires the owning Session runtime');
    }
    if (runtime.hasTurnOwner()) return undefined;
    const completion: SessionReviewCompletionInfo = {
      reviewId: pending.start.reviewId,
      status: 'interrupted',
      overallExplanation:
        'The process exited before the reviewer completed. The review was not replayed.',
      findings: [],
      completedAt: new Date().toISOString(),
      error: 'Review interrupted by process restart',
    };
    const store = new PersistentStore(projectPath);
    await store.saveReviewCompletion(sessionId, completion);
    await store.saveMessage(
      sessionId,
      'assistant',
      renderCodeReview(pending.start, completion),
      null,
      {
        codeReview: codeReviewMessageMetadata(pending.start, completion),
      }
    );
    await SessionService.updateSessionMetadata(sessionId, projectPath, {
      taskStatus: 'interrupted',
      taskStatusReason: 'Code review interrupted by process restart',
      taskCompletedAt: completion.completedAt,
      taskOwnerPid: null,
    });
    return completion;
  }

  static async list(projectPath: string, sessionId: string) {
    return projectSessionReviews(await readEvents(projectPath, sessionId));
  }
}
