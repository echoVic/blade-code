import type {
  SessionEvent,
  SessionReviewCompletionInfo,
  SessionReviewStartInfo,
  SessionReviewStatus,
} from './types.js';

export interface ProjectedSessionReview {
  start: SessionReviewStartInfo;
  completion?: SessionReviewCompletionInfo;
}

export function projectSessionReviews(
  events: readonly SessionEvent[]
): ProjectedSessionReview[] {
  const reviews = new Map<string, ProjectedSessionReview>();
  const order: string[] = [];

  for (const event of events) {
    if (event.type === 'review_started') {
      if (!reviews.has(event.data.reviewId)) {
        order.push(event.data.reviewId);
        reviews.set(event.data.reviewId, { start: event.data });
      }
      continue;
    }
    if (event.type !== 'review_completed') continue;
    const review = reviews.get(event.data.reviewId);
    if (review && review.completion === undefined) {
      review.completion = event.data;
    }
  }

  return order
    .map((reviewId) => reviews.get(reviewId))
    .filter((review): review is ProjectedSessionReview => review !== undefined);
}

export function findPendingSessionReview(
  events: readonly SessionEvent[]
): ProjectedSessionReview | undefined {
  return projectSessionReviews(events)
    .reverse()
    .find((review) => review.completion === undefined);
}

export function renderReviewStatus(status: SessionReviewStatus): string {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'stale':
      return 'stale: the review target changed while the reviewer was running';
    case 'aborted':
      return 'aborted';
    case 'interrupted':
      return 'interrupted by process restart';
    case 'failed':
      return 'failed';
  }
}

export function renderCodeReview(
  start: SessionReviewStartInfo,
  completion: SessionReviewCompletionInfo
): string {
  const lines = [
    '## Code Review',
    '',
    `Target: ${start.target.label}`,
    `Status: ${renderReviewStatus(completion.status)}`,
    '',
    completion.overallExplanation || 'No overall explanation was provided.',
  ];
  if (completion.findings.length === 0) {
    lines.push('', 'No actionable findings.');
  } else {
    lines.push('', '### Findings');
    for (const [index, finding] of completion.findings.entries()) {
      const range =
        finding.codeLocation.lineStart === finding.codeLocation.lineEnd
          ? `${finding.codeLocation.lineStart}`
          : `${finding.codeLocation.lineStart}-${finding.codeLocation.lineEnd}`;
      lines.push(
        '',
        `${index + 1}. ${finding.title}`,
        `   ${finding.codeLocation.path}:L${range} · confidence ${finding.confidenceScore.toFixed(2)}`,
        `   ${finding.body}`
      );
    }
  }
  if (completion.error) lines.push('', `Error: ${completion.error}`);
  return lines.join('\n');
}

export function codeReviewMessageMetadata(
  start: SessionReviewStartInfo,
  completion: SessionReviewCompletionInfo
) {
  return {
    reviewId: start.reviewId,
    phase: 'completed',
    status: completion.status,
    target: {
      kind: start.target.kind,
      label: start.target.label,
      ...(start.target.baseSha ? { reference: start.target.baseSha } : {}),
      ...(start.target.commitSha ? { reference: start.target.commitSha } : {}),
    },
    overallExplanation: completion.overallExplanation,
    findings: completion.findings.map((finding) => ({
      title: finding.title,
      body: finding.body,
      priority: finding.priority,
      confidenceScore: finding.confidenceScore,
      codeLocation: { ...finding.codeLocation },
    })),
    ...(completion.error ? { error: completion.error } : {}),
  };
}
