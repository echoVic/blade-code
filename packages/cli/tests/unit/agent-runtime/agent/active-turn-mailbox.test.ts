import { describe, expect, it } from 'vitest';
import { ActiveTurnMailbox } from '../../../../src/agent/runtime/ActiveTurnMailbox.js';

describe('ActiveTurnMailbox', () => {
  it('accepts steering only for an active turn and drains it in order', () => {
    const mailbox = new ActiveTurnMailbox();

    expect(mailbox.enqueue('too early')).toMatchObject({
      accepted: false,
      reason: 'no_active_turn',
    });

    const turn = mailbox.beginTurn();
    expect(mailbox.enqueue('first')).toMatchObject({
      accepted: true,
      turnId: turn.id,
      queued: 1,
    });
    expect(mailbox.enqueue('second')).toMatchObject({
      accepted: true,
      queued: 2,
    });

    expect(mailbox.drain(turn).map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
    expect(mailbox.pendingCount()).toBe(0);
    mailbox.endTurn(turn);
  });

  it('stages input during turn startup and rejects input after atomic sealing', () => {
    const mailbox = new ActiveTurnMailbox();
    expect(
      mailbox.enqueue('startup guidance', { allowBeforeTurn: true })
    ).toMatchObject({
      accepted: true,
      queued: 1,
    });

    const turn = mailbox.beginTurn();
    expect(mailbox.drain(turn)[0]?.content).toBe('startup guidance');
    expect(mailbox.drainOrSeal(turn)).toEqual({ messages: [], sealed: true });
    expect(mailbox.enqueue('too late')).toMatchObject({
      accepted: false,
      reason: 'turn_sealed',
    });
    expect(() => mailbox.beginTurn()).toThrow('already has an active turn');

    mailbox.endTurn(turn);
    expect(mailbox.beginTurn().id).toBeTruthy();
  });

  it('fails closed when the pending steering budget is exhausted', () => {
    const mailbox = new ActiveTurnMailbox();
    const turn = mailbox.beginTurn();

    for (let index = 0; index < 20; index++) {
      expect(mailbox.enqueue(`message-${index}`).accepted).toBe(true);
    }
    expect(mailbox.enqueue('overflow')).toMatchObject({
      accepted: false,
      turnId: turn.id,
      reason: 'queue_full',
      queued: 20,
    });
  });

  it('can preserve accepted guidance across a failed turn boundary', () => {
    const mailbox = new ActiveTurnMailbox();
    const failedTurn = mailbox.beginTurn();
    mailbox.enqueue('retry this guidance');
    mailbox.endTurn(failedTurn, { preservePending: true });

    const retryTurn = mailbox.beginTurn();
    expect(mailbox.drain(retryTurn).map((message) => message.content)).toEqual([
      'retry this guidance',
    ]);
  });
});
