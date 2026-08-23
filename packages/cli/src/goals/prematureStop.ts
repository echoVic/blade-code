import type { GoalPrematureStopPattern } from './types.js';

interface PatternMatcher {
  pattern: GoalPrematureStopPattern;
  expression: RegExp;
}

const PATTERNS: readonly PatternMatcher[] = [
  {
    pattern: 'unable_to_proceed',
    expression:
      /^I (?:can't|cannot|am unable to) (?:proceed|continue|make (?:any )?progress|complete|fix this)\b/i,
  },
  {
    pattern: 'stopping_here',
    expression:
      /^(?:Stopping here|I've stopped here|Paused here|Parking (?:this|the) (?:task|work|branch))\b/i,
  },
  {
    pattern: 'internal_wait',
    expression:
      /^(?:Waiting for (?:the )?(?:background )?(?:agent|subagent|task|worker|job)s?\b|[1-9]\d* (?:agent|subagent|task|worker|job)s? (?:remain|remaining|in flight|still running|still working|pending)\b)/i,
  },
  {
    pattern: 'self_deferral',
    expression:
      /^(?:I will|I'll) (?:check back|recheck|re-check|poll|retry|re-run|rerun|try again) (?:later|again|in\b|when\b|once\b|after\b|until\b)/i,
  },
  {
    pattern: 'handoff',
    expression:
      /^(?:Ready for review|Ready to (?:merge|ship|land)|(?:Opened|Created) (?:the )?PR(?: #?\d+)?|Pushed (?:the )?(?:changes|branch|commit))[.!]?$/i,
  },
];

function lastNonEmptyParagraph(text: string): string | undefined {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .at(-1);
}

export function detectGoalPrematureStop(
  content: string | undefined
): GoalPrematureStopPattern | undefined {
  if (!content?.trim()) return undefined;
  const paragraph = lastNonEmptyParagraph(content);
  if (!paragraph) return undefined;

  for (const line of paragraph.split('\n')) {
    const candidate = line.trim();
    for (const matcher of PATTERNS) {
      if (matcher.expression.test(candidate)) return matcher.pattern;
    }
  }
  return undefined;
}
