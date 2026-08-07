import { describe, expect, it } from 'vitest';
import { selectStaticContentEncoding } from '../../../../src/server/server.js';

describe('static asset content negotiation', () => {
  it('prefers Brotli when the client accepts both encodings equally', () => {
    expect(selectStaticContentEncoding('gzip, deflate, br')).toBe('br');
  });

  it('honors quality values and disabled encodings', () => {
    expect(selectStaticContentEncoding('br;q=0.4, gzip;q=0.9')).toBe('gzip');
    expect(selectStaticContentEncoding('br;q=0, gzip;q=0')).toBeUndefined();
  });

  it('supports wildcard negotiation and identity fallback', () => {
    expect(selectStaticContentEncoding('*;q=0.5')).toBe('br');
    expect(selectStaticContentEncoding(undefined)).toBeUndefined();
  });
});
