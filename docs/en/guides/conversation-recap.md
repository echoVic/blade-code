# Conversation recap

During longer tasks, Blade automatically inserts a short progress recap:

> ↶ recap: The goal is to finish the event-log migration. Tasks 1 and 2 are committed and tests pass; task 2 is still under review. Next, address the review and start task 3.

The terminal and Web UI show this as muted italic text, usually two or three
sentences covering the goal, completed progress, current waiting or blockers, and
the next step. It follows the conversation language and requires no command.

## When it appears

The main agent checks between model calls. A recap requires at least two minutes
and five new completed model rounds. Successful context compaction can also
trigger one, subject to the same two-minute cooldown.
Short tasks, subagents, and tasks requiring structured output skip recaps.

Each recap makes one additional bounded, tool-free request using the current model,
with a ten-second deadline. Its cost counts as auxiliary token usage.
A failed recap is skipped and the main task continues.

## History and cancellation

A recap records the state at generation time and remains in conversation history.
Restoring a session only replays existing recaps. Recaps are excluded from subsequent
main-model context and cannot execute tools, change task status, or alter compaction
checkpoints. Cancelling the task also cancels an in-flight recap.

The input uses effective context, including any existing compaction summary.
Long histories preserve the initial goal and recent evidence; an explicit notice
appears when history is shortened. The prompt requires distinguishing plans,
attempts, and verified results.

ACP projects `recap:` text with `blade/conversationRecap` metadata.
Headless text mode writes recaps to stderr. JSONL mode emits a separate
`conversation_recap` event with `message_id` and `text`, separate from the answer.
