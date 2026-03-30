# Web Image Input Design

## Summary

Add image input support to the Web chat composer with two user entry points:

- Paste images directly into the chat textarea with `Cmd+V` / `Ctrl+V`
- Select one or more images through the existing `Paperclip` button

This is a full-stack change. The feature is only considered complete if Web users can:

1. attach images before sending,
2. send text-only, image-only, or mixed text+image messages,
3. see image previews in the composer and user message bubbles, and
4. reload an existing session and still see previously sent images.

## Problem

The current Web client only sends plain string content.

- [`ChatInput.tsx`](../../../packages/cli/web/src/components/chat/ChatInput.tsx) has no attachment state, no paste-image handling, and the `Paperclip` button is inert.
- [`sessionService.ts`](../../../packages/cli/web/src/services/sessionService.ts) posts `{ content, permissionMode }` only.
- [`sessionSlice.ts`](../../../packages/cli/web/src/store/session/slices/sessionSlice.ts) assumes outgoing user messages are text-only.
- [`ChatMessage.tsx`](../../../packages/cli/web/src/components/chat/ChatMessage.tsx) renders user messages as plain text.
- The server route already accepts `attachments`, but ignores them when executing runs.
- Shared session persistence currently stores user messages as a single `text` part, so image content is lost after reload.
- When a Web session is not present in memory, [`session.ts`](../../../packages/cli/src/server/routes/session.ts) recreates it with an empty `messages` array instead of hydrating persisted history. That means history continuation in Web is already incomplete even before image support.

## Goals

- Support paste-to-attach for clipboard images in the Web chat input.
- Support file-picker image attachment from the `Paperclip` button.
- Allow multiple images per message.
- Allow image-only messages.
- Preserve attachment order as shown in the composer.
- Render user message images in the current session and after session reload.
- Rehydrate persisted Web sessions so follow-up prompts continue with prior multimodal history.

## Non-Goals

- No drag-and-drop upload in this iteration.
- No generic file attachments in this iteration. Only browser-supported image files are in scope.
- No client-side resize, compression, or annotation workflow.
- No assistant-side image rendering requirements beyond preserving multimodal message history for the model and showing user-sent image previews in chat.

## User-Facing Behavior

### Composer

- Pasting one or more images into the textarea adds them as attachments instead of inserting text.
- Clicking `Paperclip` opens a hidden file input restricted to `image/*`.
- The composer shows attachment thumbnails above the textarea.
- Each thumbnail has a remove action before send.
- Sending clears both text input and pending attachments.
- The send button is enabled when there is either:
  - non-empty text, or
  - at least one attached image.

### Message layout

- User bubbles render text first, followed by attached images.
- Pure image messages render an image grid without requiring fallback text.
- Multiple images render in attachment order.
- Existing text sanitization for `<system-reminder>` and `<file>` blocks still applies to the textual portion only.

### Persistence and resume

- Refreshing the page or reopening a saved session still shows user-sent images.
- Sending a follow-up message in a persisted Web session must include earlier image messages in the in-memory conversation passed to the agent.

## Architecture Decision

Chosen approach: upgrade the shared message flow to handle multimodal user content end-to-end instead of adding a Web-only attachment side channel.

Why:

- The agent already supports `Message.content` as `string | ContentPart[]`.
- The server request schema already includes `attachments`.
- A Web-only workaround would still lose images on reload and would not preserve prior multimodal context.

## Data Model

### Web composer state

Add a Web-local attachment model:

```ts
type ComposerImageAttachment = {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}
```

Rules:

- `id` is client-generated and stable for React rendering/removal.
- `dataUrl` is used for preview and request payload.
- Attachment order is append-only based on user action order.

### Shared message content

Web store and service types must stop collapsing all messages to plain strings. User messages need to preserve multimodal content:

```ts
type WebMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >
```

Web rendering may normalize this into:

- `textContent: string`
- `imageUrls: string[]`

but the stored message shape itself must preserve the original multimodal form.

### Persistent JSONL parts

Extend shared session persistence to support an image part:

```ts
type PartType =
  | 'text'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref'
```

Image payload:

```ts
{
  mimeType: string
  dataUrl: string
}
```

Decision:

- Persist the complete Data URL string.
- Do not split binary storage from session JSONL in this iteration.
- Preserve part ordering by emitting `part_created` entries in display order.

## Request/Response Flow

### Web client -> server

`sessionService.sendMessage()` will send:

```json
{
  "content": "optional text",
  "permissionMode": "default",
  "attachments": [
    {
      "type": "image",
      "content": "data:image/png;base64,..."
    }
  ]
}
```

Rules:

- `content` may be an empty string when attachments exist.
- Attachment `content` stores the full Data URL.
- Web temp user messages should use the same multimodal shape the server will later return, so optimistic UI and persisted UI match.

### Server -> agent

In [`session.ts`](../../../packages/cli/src/server/routes/session.ts):

- Parse `attachments` from the request body.
- Convert the incoming request into `UserMessageContent`:
  - prepend one text part when `content.trim()` is non-empty,
  - append one image part per attachment in attachment order.
- For text-only requests, continue using a plain string to minimize unrelated churn.
- For mixed or image-only requests, call `agent.chat()` with `ContentPart[]`.

### Session hydration

When `POST /sessions/:sessionId/message` receives a session id that is not currently in the in-memory `sessions` map:

- try to load persisted message history through `SessionService.loadSession(sessionId)`,
- initialize `session.messages` with that history,
- then append the new user message and assistant response.

This fixes existing Web follow-up behavior for persisted sessions and is required for multimodal continuity.

## Persistence Flow

### Writing

Update shared persistence helpers so saving a multimodal user message writes:

- one `message_created` event,
- one `part_created(text)` event for each text part,
- one `part_created(image)` event for each image part,
- in original part order.

Assistant and tool messages remain unchanged.

### Reading

Update shared session loading so consecutive parts for a single message reconstruct:

- `string` when the message only has one text part,
- `ContentPart[]` when it has mixed text/image parts or multiple ordered parts.

Web consumers must stop stringifying arrays during fetch normalization. Text extraction for existing views should happen in rendering helpers, not in the transport layer.

## Rendering Strategy

Add a small normalization helper in Web chat rendering:

- Extract text parts into a single display string joined with `\n`.
- Extract image parts into an ordered image list.

Rendering rules:

- user text remains monospaced and wrapped as today,
- images render below text with rounded corners and constrained max dimensions,
- single image can use a larger width,
- multiple images render in a responsive grid,
- clicking preview expansion is out of scope.

## Validation and Error Handling

- Ignore non-image pasted clipboard items and fall back to normal text paste behavior.
- Reject non-image files selected from the file picker.
- If file reading fails, keep existing composer state and surface a local error message near the composer.
- Do not block sending because one attachment failed to preview; only successfully parsed images are attached.
- Empty text plus zero valid attachments must still be rejected.

## Compatibility Constraints

- Existing text-only Web chat behavior must remain unchanged.
- Existing persisted text-only sessions must continue to load without migration.
- Older messages without image parts must still deserialize exactly as before.
- Any code path that assumes `message.content` is always a string must either:
  - stay on a string-only input path, or
  - be upgraded to handle `ContentPart[]`.

## Files Expected To Change

Web:

- `packages/cli/web/src/components/chat/ChatInput.tsx`
- `packages/cli/web/src/components/chat/ChatView.tsx`
- `packages/cli/web/src/components/chat/ChatMessage.tsx`
- `packages/cli/web/src/services/sessionService.ts`
- `packages/cli/web/src/store/session/types.ts`
- `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- `packages/cli/web/tests/components/chat/ChatMessage.test.tsx`
- new Web tests for `ChatInput` and/or session sending

Shared/server:

- `packages/cli/src/api/schemas.ts`
- `packages/cli/src/server/routes/session.ts`
- `packages/cli/src/context/types.ts`
- `packages/cli/src/context/storage/PersistentStore.ts`
- `packages/cli/src/services/SessionService.ts`
- `packages/cli/src/agent/Agent.ts`

## Testing Requirements

- Web component test for paste-image attachment flow.
- Web component test for `Paperclip` image selection flow.
- Web store/service test verifying `sendMessage` includes image attachments.
- Web rendering test verifying user messages render text and image previews from multimodal content.
- Shared persistence test verifying a saved multimodal user message reloads with image parts intact.
- Server route test verifying persisted session hydration before follow-up send.

## Open Decisions Resolved Here

- Multiple images: supported.
- Pure image messages: supported.
- Ordering: text first, then images in attachment order.
- Storage format: Data URLs persisted inline in JSONL for this iteration.
- Scope: Web input + shared transport/persistence needed to make Web history and follow-up prompts correct.

## Spec Self-Review

### Completeness

This spec covers input capture, optimistic UI, transport, server execution, persistence, history reload, and follow-up context hydration.

### Internal consistency

The selected architecture keeps one message model across Web UI, server execution, and persistence. There is no separate Web-only attachment representation after the request boundary.

### Scope check

This remains one implementation plan. The work spans multiple layers, but all changes serve one user-visible feature: multimodal image input in Web chat with persistence.

### Ambiguity check

The spec explicitly defines message ordering, image-only behavior, and the storage format, which were the main ambiguous areas.
