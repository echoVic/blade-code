import { describe, expect, it } from 'vitest';
import {
  isExpectedBrowserRequestFailure,
  parseForegroundGuiReadyLine,
} from '../../support/foregroundBoundedOutputWebDriver.js';

describe('foreground bounded output Web driver', () => {
  it('accepts only a safe minimal launcher ready record', () => {
    expect(parseForegroundGuiReadyLine('{"ready":true,"port":4312}')).toEqual({
      ready: true,
      port: 4312,
    });
    expect(
      parseForegroundGuiReadyLine(
        '{"home":"/private/home","storage":"/private/storage","port":4312}'
      )
    ).toBeUndefined();
    expect(parseForegroundGuiReadyLine('not-json')).toBeUndefined();
  });

  it('allows only navigation or EventSource aborts during an explicit refresh', () => {
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/',
        resourceType: 'document',
        errorText: 'net::ERR_ABORTED',
        refreshing: true,
        closing: false,
      })
    ).toBe(true);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_ABORTED',
        refreshing: true,
        closing: false,
      })
    ).toBe(true);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/api/messages',
        resourceType: 'fetch',
        errorText: 'net::ERR_FAILED',
        refreshing: true,
        closing: false,
      })
    ).toBe(false);
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_ABORTED',
        refreshing: false,
        closing: false,
      })
    ).toBe(false);
  });

  it('allows request failures once driver cleanup begins', () => {
    expect(
      isExpectedBrowserRequestFailure({
        url: 'http://127.0.0.1:4312/sessions/s/events',
        resourceType: 'eventsource',
        errorText: 'net::ERR_FAILED',
        refreshing: false,
        closing: true,
      })
    ).toBe(true);
  });
});
