import { describe, expect, it } from 'vitest';
import type { DurableSteeringMessage } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import { projectFollowUpQueue } from '../../../../src/agent/runtime/FollowUpQueueProjection.js';

function message(
  id: string,
  content: DurableSteeringMessage['content'],
  options: Partial<DurableSteeringMessage> = {}
): DurableSteeringMessage {
  return {
    id,
    content,
    queuedAt: 1_788_544_800_000,
    recovered: false,
    ...options,
  };
}

describe('follow-up queue projection', () => {
  it('projects bounded user previews and attachment counts without image data', () => {
    const secretImage = 'data:image/png;base64,SECRET_IMAGE_BYTES';
    const snapshot = projectFollowUpQueue({
      generation: 'inbox-generation',
      ownerEpoch: 'owner-epoch',
      claimRevision: 0,
      messages: [
        message('user-message', [
          { type: 'text', text: '😀'.repeat(300) },
          { type: 'image_url', image_url: { url: secretImage } },
        ]),
      ],
      primaryInputIds: new Set<string>(),
      reservedIds: new Set<string>(),
      claimedIds: new Set<string>(),
      recoveryProtectedIds: new Set<string>(),
      hasActiveTurn: true,
    });

    expect(snapshot).toMatchObject({
      pending: 1,
      mutable: 1,
      locked: 0,
      internal: 0,
      items: [
        {
          id: 'user-message',
          kind: 'user',
          state: 'pending',
          delivery: 'current_turn',
          mutable: true,
          previewTruncated: true,
          attachmentCount: 1,
        },
      ],
    });
    expect(snapshot.version).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.items[0]?.preview).toHaveLength(240);
    expect(JSON.stringify(snapshot)).not.toContain(secretImage);
  });

  it('hides internal content and makes durable recovery input immutable', () => {
    const internalSecret = 'INTERNAL_COMPLETION_SECRET';
    const snapshot = projectFollowUpQueue({
      generation: 'inbox-generation',
      ownerEpoch: 'owner-epoch',
      claimRevision: 3,
      messages: [
        message('internal-raw-id', internalSecret, {
          origin: 'background_subagent',
          persisted: true,
        }),
        message('shell-raw-id', 'SECRET_SHELL_OUTPUT', {
          origin: 'user_shell',
          persisted: true,
        }),
        message('recovery-user', 'recover me', { recovered: true }),
      ],
      primaryInputIds: new Set<string>(),
      reservedIds: new Set<string>(),
      claimedIds: new Set<string>(),
      recoveryProtectedIds: new Set(['recovery-user']),
      hasActiveTurn: false,
    });

    expect(snapshot).toMatchObject({ pending: 3, mutable: 0, locked: 3, internal: 2 });
    expect(snapshot.items[0]).toMatchObject({
      kind: 'internal',
      state: 'locked',
      mutable: false,
    });
    expect(snapshot.items[0]?.id).not.toBe('internal-raw-id');
    expect(snapshot.items[0]?.preview).toBeUndefined();
    expect(snapshot.items[1]).toMatchObject({
      kind: 'internal',
      state: 'locked',
      mutable: false,
    });
    expect(snapshot.items[2]).toMatchObject({
      id: 'recovery-user',
      state: 'locked',
      delivery: 'recovery',
      mutable: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(internalSecret);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_SHELL_OUTPUT');
  });

  it('changes the opaque version for owner and claim changes', () => {
    const input = {
      generation: 'same-generation',
      ownerEpoch: 'owner-a',
      claimRevision: 0,
      messages: [message('one', 'one')],
      primaryInputIds: new Set<string>(),
      reservedIds: new Set<string>(),
      claimedIds: new Set<string>(),
      recoveryProtectedIds: new Set<string>(),
      hasActiveTurn: true,
    };
    const first = projectFollowUpQueue(input);
    const replacedOwner = projectFollowUpQueue({ ...input, ownerEpoch: 'owner-b' });
    const claimed = projectFollowUpQueue({
      ...input,
      claimRevision: 1,
      claimedIds: new Set(['one']),
    });

    expect(replacedOwner.version).not.toBe(first.version);
    expect(claimed.version).not.toBe(first.version);
    expect(claimed.items[0]).toMatchObject({ state: 'locked', mutable: false });
  });

  it('omits the active turn primary input from the follow-up queue', () => {
    const snapshot = projectFollowUpQueue({
      generation: 'direct-generation',
      ownerEpoch: 'owner',
      claimRevision: 1,
      messages: [message('direct', 'primary request'), message('follow-up', 'later')],
      primaryInputIds: new Set(['direct']),
      reservedIds: new Set(['direct']),
      claimedIds: new Set(['direct']),
      recoveryProtectedIds: new Set<string>(),
      hasActiveTurn: true,
    });

    expect(snapshot.pending).toBe(1);
    expect(snapshot.items.map((item) => item.id)).toEqual(['follow-up']);
  });

  it('keeps a transcript-persisted user item visible but immutable', () => {
    const snapshot = projectFollowUpQueue({
      generation: 'persisted-generation',
      ownerEpoch: 'owner',
      claimRevision: 0,
      messages: [message('persisted-user', 'already observed', { persisted: true })],
      primaryInputIds: new Set<string>(),
      reservedIds: new Set<string>(),
      claimedIds: new Set<string>(),
      recoveryProtectedIds: new Set<string>(),
      hasActiveTurn: false,
    });

    expect(snapshot.items[0]).toMatchObject({
      id: 'persisted-user',
      kind: 'user',
      state: 'locked',
      mutable: false,
      preview: 'already observed',
    });
  });

  it('does not expose an artifact identifier in a queue preview', () => {
    const artifactId = 'f'.repeat(64);
    const snapshot = projectFollowUpQueue({
      generation: 'artifact-generation',
      ownerEpoch: 'owner',
      claimRevision: 0,
      messages: [
        message('artifact-user', 'preview artifact_id=' + artifactId, {
          metadata: {
            userPromptArtifact: {
              version: 1,
              id: artifactId,
              sha256: artifactId,
              sizeBytes: 40_000,
              textChars: 40_000,
              inlineBytes: 32_000,
            },
          },
        }),
      ],
      primaryInputIds: new Set<string>(),
      reservedIds: new Set<string>(),
      claimedIds: new Set<string>(),
      recoveryProtectedIds: new Set<string>(),
      hasActiveTurn: false,
    });

    expect(snapshot.items[0]).toMatchObject({
      kind: 'user',
      mutable: false,
      previewTruncated: false,
    });
    expect(snapshot.items[0]?.preview).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(artifactId);
  });
});
