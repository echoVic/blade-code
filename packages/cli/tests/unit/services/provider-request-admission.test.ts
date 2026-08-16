import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  MAX_PROVIDER_REQUEST_CONCURRENCY,
  MIN_PROVIDER_REQUEST_CONCURRENCY,
} from '../../../src/config/providerRequestAdmission.js';
import {
  createProviderRequestDomainKey,
  PROVIDER_ADMISSION_AGING_MS,
  PROVIDER_ADMISSION_DOMAIN_MAX_PENDING,
  ProviderAdmissionError,
  type ProviderAdmissionRequest,
  ProviderRequestAdmissionScheduler,
  type ProviderRequestScope,
} from '../../../src/services/pi/providerRequestAdmission.js';

const TEST_SECRET = new Uint8Array(32).fill(11);

function scope(
  model: string,
  overrides: Partial<ProviderRequestScope> = {}
): ProviderRequestScope {
  return {
    provider: 'deepseek',
    api: 'openai-completions',
    baseUrl: 'https://provider.example/v1',
    model,
    serviceTier: 'default',
    apiVersion: '2026-08-16',
    apiKey: 'private-key',
    customHeaders: {
      Authorization: 'Bearer private-token',
      'x-route-tenant': 'tenant-a',
    },
    maxConcurrent: DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
    ...overrides,
  };
}

function request(
  model: string,
  ownerId: string,
  requestClass: ProviderAdmissionRequest['requestClass'] = 'foreground',
  overrides: Partial<ProviderAdmissionRequest> = {}
): ProviderAdmissionRequest {
  return {
    scope: scope(model),
    sessionId: `${ownerId}-session`,
    ownerId,
    requestClass,
    maxWaitMs: DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
    ...overrides,
  };
}

function scheduler(
  overrides: ConstructorParameters<typeof ProviderRequestAdmissionScheduler>[0] = {}
) {
  return new ProviderRequestAdmissionScheduler({
    processSecret: TEST_SECRET,
    ...overrides,
  });
}

async function permit(
  admission: ReturnType<ProviderRequestAdmissionScheduler['admit']>
) {
  return admission.ready;
}

describe('ProviderRequestAdmissionScheduler', () => {
  it('freezes the production bounds', () => {
    expect(DEFAULT_PROVIDER_REQUEST_CONCURRENCY).toBe(4);
    expect(MIN_PROVIDER_REQUEST_CONCURRENCY).toBe(1);
    expect(MAX_PROVIDER_REQUEST_CONCURRENCY).toBe(16);
    expect(DEFAULT_PROVIDER_REQUEST_ADMISSION_MS).toBe(180_000);
    expect(PROVIDER_ADMISSION_DOMAIN_MAX_PENDING).toBe(32);
    expect(PROVIDER_ADMISSION_AGING_MS).toBe(30_000);
  });

  it('bounds active streams per sensitive failure domain', async () => {
    const gate = scheduler();
    const active = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        permit(gate.admit(request('shared-model', `owner-${index}`)))
      )
    );
    const waiting = gate.admit(request('shared-model', 'owner-waiting'));

    expect(waiting.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'domain',
      inFlight: 4,
      limit: 4,
      queuePosition: 1,
    });
    expect(gate.getStats()).toMatchObject({
      inFlight: 4,
      queued: 1,
      domainCount: 1,
      ownerCount: 5,
    });

    active[0].release();
    const admitted = await waiting.ready;
    expect(waiting.getSnapshot()).toMatchObject({
      state: 'admitted',
      queuePosition: 0,
    });
    admitted.release();
    for (const held of active.slice(1)) held.release();
    expect(gate.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      domainCount: 0,
      ownerCount: 0,
    });
  });

  it('bounds active streams across independent domains', async () => {
    const gate = scheduler({ globalMaxInFlight: 2 });
    const first = await permit(gate.admit(request('model-a', 'owner-a')));
    const second = await permit(gate.admit(request('model-b', 'owner-b')));
    const waiting = gate.admit(request('model-c', 'owner-c'));

    expect(waiting.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'global',
      inFlight: 2,
      limit: 2,
    });
    first.release();
    const third = await waiting.ready;
    third.release();
    second.release();
  });

  it('prevents one root owner from occupying every domain slot', async () => {
    const gate = scheduler({ ownerMaxInFlight: 2 });
    const first = await permit(
      gate.admit(request('shared-model', 'owner-a', 'foreground', { sessionId: 'a-1' }))
    );
    const second = await permit(
      gate.admit(request('shared-model', 'owner-a', 'foreground', { sessionId: 'a-2' }))
    );
    const ownerWaiting = gate.admit(
      request('shared-model', 'owner-a', 'foreground', { sessionId: 'a-3' })
    );
    const otherOwner = await permit(
      gate.admit(request('shared-model', 'owner-b', 'foreground'))
    );

    expect(ownerWaiting.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'owner',
      inFlight: 2,
      limit: 2,
    });
    otherOwner.release();
    first.release();
    const third = await ownerWaiting.ready;
    third.release();
    second.release();
  });

  it('reserves global, domain, and owner capacity for foreground work', async () => {
    const gate = scheduler({
      globalMaxInFlight: 4,
      nonForegroundGlobalMaxInFlight: 3,
      ownerMaxInFlight: 3,
      nonForegroundOwnerMaxInFlight: 2,
    });
    const background = await Promise.all([
      permit(
        gate.admit(
          request('shared-model', 'owner-a', 'background', { sessionId: 'child-a' })
        )
      ),
      permit(
        gate.admit(
          request('shared-model', 'owner-a', 'background', { sessionId: 'child-b' })
        )
      ),
    ]);
    const blockedBackground = gate.admit(
      request('shared-model', 'owner-a', 'background', { sessionId: 'child-c' })
    );
    expect(blockedBackground.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'class',
      inFlight: 2,
      limit: 2,
    });
    const foreground = gate.admit(
      request('shared-model', 'owner-a', 'foreground', { sessionId: 'root-a' })
    );
    expect(foreground.getSnapshot().state).toBe('admitted');
    const foregroundPermit = await foreground.ready;
    foregroundPermit.release();
    background[0].release();
    const promoted = await blockedBackground.ready;
    promoted.release();
    background[1].release();
  });

  it('allows one background stream when domain concurrency is one', async () => {
    const gate = scheduler();
    const held = await permit(
      gate.admit(
        request('serial-model', 'owner-a', 'background', {
          scope: scope('serial-model', { maxConcurrent: 1 }),
        })
      )
    );
    const foreground = gate.admit(
      request('serial-model', 'owner-b', 'foreground', {
        scope: scope('serial-model', { maxConcurrent: 1 }),
      })
    );
    expect(foreground.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'domain',
      limit: 1,
    });
    held.release();
    const next = await foreground.ready;
    next.release();
  });

  it('caps internal streams separately from other background work', async () => {
    const gate = scheduler({
      internalGlobalMaxInFlight: 1,
      internalDomainMaxInFlight: 1,
    });
    const held = await permit(gate.admit(request('model-a', 'internal-a', 'internal')));
    const waiting = gate.admit(request('model-b', 'internal-b', 'internal'));
    const background = await permit(
      gate.admit(request('model-b', 'background-b', 'background'))
    );

    expect(waiting.getSnapshot()).toMatchObject({
      state: 'queued',
      scope: 'class',
      inFlight: 1,
      limit: 1,
    });
    background.release();
    held.release();
    const admitted = await waiting.ready;
    admitted.release();
  });

  it('round-robins the first queued request from each root owner', async () => {
    const gate = scheduler({ globalMaxInFlight: 1, ownerMaxInFlight: 1 });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const order: string[] = [];
    const queued = [
      ['a-1', gate.admit(request('model-a', 'owner-a', 'foreground'))],
      [
        'a-2',
        gate.admit(
          request('model-a', 'owner-a', 'foreground', { sessionId: 'owner-a-2' })
        ),
      ],
      ['b-1', gate.admit(request('model-b', 'owner-b', 'foreground'))],
    ] as const;
    for (const [label, ticket] of queued) {
      void ticket.ready.then((entry) => {
        order.push(label);
        entry.release();
      });
    }

    held.release();
    await Promise.all(queued.map(([, ticket]) => ticket.ready));
    expect(order).toEqual(['a-1', 'b-1', 'a-2']);
  });

  it('prioritizes foreground work over newer background work', async () => {
    const gate = scheduler({ globalMaxInFlight: 1 });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const order: string[] = [];
    const background = gate.admit(request('model-a', 'owner-a', 'background'));
    const foreground = gate.admit(request('model-b', 'owner-b', 'foreground'));
    void background.ready.then((entry) => {
      order.push('background');
      entry.release();
    });
    void foreground.ready.then((entry) => {
      order.push('foreground');
      entry.release();
    });

    held.release();
    await Promise.all([background.ready, foreground.ready]);
    expect(order).toEqual(['foreground', 'background']);
  });

  it('ages internal work into foreground rank without a sweep timer', async () => {
    let now = 0;
    const gate = scheduler({
      globalMaxInFlight: 1,
      now: () => now,
    });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const order: string[] = [];
    const internal = gate.admit(request('model-a', 'owner-a', 'internal'));
    now = PROVIDER_ADMISSION_AGING_MS * 2;
    const foreground = gate.admit(request('model-b', 'owner-b', 'foreground'));
    void internal.ready.then((entry) => {
      order.push('internal');
      entry.release();
    });
    void foreground.ready.then((entry) => {
      order.push('foreground');
      entry.release();
    });

    held.release();
    await Promise.all([internal.ready, foreground.ready]);
    expect(order).toEqual(['internal', 'foreground']);
  });

  it('rejects owner, domain, and global overflow before retaining more work', async () => {
    const ownerGate = scheduler({
      globalMaxInFlight: 1,
      ownerMaxInFlight: 1,
      ownerMaxPending: 1,
    });
    const ownerHeld = await permit(ownerGate.admit(request('model', 'owner-a')));
    ownerGate.admit(
      request('model', 'owner-a', 'foreground', { sessionId: 'owner-a-queued' })
    );
    expect(() =>
      ownerGate.admit(
        request('model', 'owner-a', 'foreground', {
          sessionId: 'owner-a-overflow',
        })
      )
    ).toThrowError(
      expect.objectContaining({
        reason: 'queue_full',
        scope: 'owner',
      })
    );
    ownerGate.close();
    ownerHeld.release();

    const domainGate = scheduler({
      globalMaxInFlight: 1,
      domainMaxPending: 1,
      ownerMaxPending: 4,
    });
    const domainHeld = await permit(domainGate.admit(request('model', 'owner-a')));
    domainGate.admit(request('model', 'owner-b'));
    expect(() => domainGate.admit(request('model', 'owner-c'))).toThrowError(
      expect.objectContaining({
        reason: 'queue_full',
        scope: 'domain',
      })
    );
    domainGate.close();
    domainHeld.release();

    const globalGate = scheduler({
      globalMaxInFlight: 1,
      globalMaxPending: 1,
      domainMaxPending: 4,
      ownerMaxPending: 4,
    });
    const globalHeld = await permit(globalGate.admit(request('model-a', 'owner-a')));
    globalGate.admit(request('model-b', 'owner-b'));
    expect(() => globalGate.admit(request('model-c', 'owner-c'))).toThrowError(
      expect.objectContaining({
        reason: 'queue_full',
        scope: 'global',
      })
    );
    expect(globalGate.getStats()).toMatchObject({
      inFlight: 1,
      queued: 1,
      domainCount: 2,
      ownerCount: 2,
    });
    globalGate.close();
    globalHeld.release();
  });

  it('removes an aborted queued ticket and preserves the caller reason', async () => {
    const gate = scheduler({ globalMaxInFlight: 1 });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const controller = new AbortController();
    const reason = new Error('caller stopped waiting');
    const waiting = gate.admit(
      request('model', 'owner-a', 'foreground', {
        signal: controller.signal,
      })
    );

    controller.abort(reason);
    await expect(waiting.ready).rejects.toBe(reason);
    expect(gate.getStats()).toMatchObject({ inFlight: 1, queued: 0 });
    held.release();
    expect(gate.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      domainCount: 0,
      ownerCount: 0,
    });
  });

  it('times out queued work with a sanitized retryable error', async () => {
    const gate = scheduler({ globalMaxInFlight: 1 });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const waiting = gate.admit(
      request('model', 'owner-a', 'foreground', { maxWaitMs: 10 })
    );

    await expect(waiting.ready).rejects.toMatchObject({
      name: 'ProviderAdmissionError',
      code: 'PROVIDER_ADMISSION_BUSY',
      retryable: true,
      reason: 'wait_timeout',
    });
    expect(gate.getStats()).toMatchObject({ inFlight: 1, queued: 0 });
    held.release();
  });

  it('releases permits idempotently and clears idle state', async () => {
    const gate = scheduler();
    const acquired = await permit(gate.admit(request('model', 'owner-a')));
    acquired.release();
    acquired.release();
    expect(gate.getStats()).toEqual({
      inFlight: 0,
      queued: 0,
      nonForegroundInFlight: 0,
      internalInFlight: 0,
      domainCount: 0,
      ownerCount: 0,
      closed: false,
    });
  });

  it('canonicalizes equivalent routing and isolates every sensitive dimension', () => {
    const equivalentA = createProviderRequestDomainKey(
      scope('model', {
        baseUrl: 'https://PROVIDER.example/v1/',
        customHeaders: {
          Authorization: 'Bearer private-token',
          'X-Route-Tenant': 'tenant-a',
        },
      }),
      TEST_SECRET
    );
    const equivalentB = createProviderRequestDomainKey(
      scope('model', {
        baseUrl: 'https://provider.example/v1',
        customHeaders: {
          'x-route-tenant': 'tenant-a',
          authorization: 'Bearer private-token',
        },
      }),
      TEST_SECRET
    );
    expect(equivalentA).toBe(equivalentB);

    for (const changed of [
      scope('other-model'),
      scope('model', { baseUrl: 'https://other.example/v1' }),
      scope('model', { apiKey: 'other-key' }),
      scope('model', { serviceTier: 'priority' }),
      scope('model', { apiVersion: 'other-version' }),
      scope('model', { customHeaders: { 'x-route-tenant': 'tenant-b' } }),
      scope('model', { maxConcurrent: 8 }),
    ]) {
      expect(createProviderRequestDomainKey(changed, TEST_SECRET)).not.toBe(
        equivalentA
      );
    }

    expect(equivalentA).not.toContain('private');
    expect(equivalentA).not.toContain('tenant');
    expect(equivalentA).toMatch(/^[a-f0-9]{64}$/);
  });

  it('closes pending and future admission without disturbing active release', async () => {
    const gate = scheduler({ globalMaxInFlight: 1 });
    const held = await permit(gate.admit(request('holder', 'holder')));
    const waiting = gate.admit(request('model', 'owner-a'));
    gate.close();

    await expect(waiting.ready).rejects.toMatchObject({
      reason: 'closed',
      retryable: false,
    });
    expect(() => gate.admit(request('future', 'owner-b'))).toThrow(
      ProviderAdmissionError
    );
    held.release();
    expect(gate.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      closed: true,
    });
  });
});
