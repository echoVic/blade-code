import type { PartType } from '../types.js';

/**
 * Ephemeral in-flight delta — a streaming increment for a part that is still
 * being produced within the current turn. Deltas are a UI-rendering optimization
 * only: they are NEVER persisted to JSONL and NEVER assigned a `seq`.
 *
 * Each delta anchors to the committed `part_created` event it extends via
 * {@link anchorSeq}, and carries a turn-local {@link deltaIndex} for ordering.
 * When the turn ends, the loop emits a committed `part_updated` holding the full
 * text as the part's final truth, which idempotently supersedes the deltas. On
 * reconnect, deltas are not replayed — the client renders from the anchor part's
 * latest committed text and picks up subsequent live deltas.
 */
export interface EphemeralDelta {
  sessionId: string;
  projectPath: string;
  /** seq of the committed part_created this delta extends. */
  anchorSeq: number;
  /** part identity being streamed. */
  partId: string;
  /** message the part belongs to. */
  messageId: string;
  /** which kind of streaming content this delta carries. */
  partType: Extract<PartType, 'text'>;
  /** the streaming channel: assistant content vs reasoning/thinking. */
  channel: 'content' | 'thinking';
  /** monotonic index within the current turn, for ordering/debug. */
  deltaIndex: number;
  /** the incremental text fragment. */
  delta: string;
}
