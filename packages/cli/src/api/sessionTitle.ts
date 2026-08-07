/**
 * Shared session-title derivation.
 *
 * Production coding agents (Codex, Grok Build, Claude Code) name a session
 * after its opening intent rather than a timestamp. We take the deterministic
 * route: derive a concise, human-scannable title from the first user message.
 * Deterministic derivation has zero latency, needs no LLM round-trip, and works
 * identically across CLI, Web, and ACP — the single source of truth lives here
 * so all three surfaces stay consistent.
 */

const MAX_TITLE_LENGTH = 60;

/** Strip harness-injected wrappers that must never leak into a title. */
const STRIP_PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<file[^>]*>[\s\S]*?<\/file>/gi,
  /<hooks_context>[\s\S]*?<\/hooks_context>/gi,
  /<[^>]+>/g, // any remaining tags
];

/**
 * Flatten a message content value (string or content-part array) to plain text.
 * Only textual parts contribute; image parts are ignored.
 */
export function flattenMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * Derive a concise session title from raw first-message text. Returns an empty
 * string when nothing meaningful remains (caller decides the fallback).
 */
export function deriveSessionTitle(raw: string): string {
  let text = raw;
  for (const pattern of STRIP_PATTERNS) {
    text = text.replace(pattern, ' ');
  }

  // Drop leading slash-command tokens (e.g. "/goal ...") but keep the intent.
  text = text.replace(/^\s*\/[a-zA-Z][\w-]*\s+/, '');

  // Collapse whitespace; prefer the first sentence/line as the headline.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';

  // Cut at the first sentence boundary when it yields a reasonable headline.
  // Latin sentences end with punctuation + whitespace; CJK punctuation stands
  // alone, so allow either a following space or end-of-string.
  const sentenceMatch = collapsed.match(/^(.+?)(?:[.!?]\s|[。！？](?=\S|$)|$)/);
  let headline =
    sentenceMatch && sentenceMatch[1].length >= 6 ? sentenceMatch[1] : collapsed;

  headline = headline.trim().replace(/[\s.。!！?？,，;；:：-]+$/, '');

  if (headline.length <= MAX_TITLE_LENGTH) return headline;
  // Prefer breaking on a word boundary near the limit.
  const truncated = headline.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const base =
    lastSpace > MAX_TITLE_LENGTH * 0.6 ? truncated.slice(0, lastSpace) : truncated;
  return `${base.trimEnd()}…`;
}

/**
 * Derive a title directly from a message content value, flattening it first.
 */
export function deriveSessionTitleFromContent(content: unknown): string {
  return deriveSessionTitle(flattenMessageText(content));
}
