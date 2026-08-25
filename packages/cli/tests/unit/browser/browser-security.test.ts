import { describe, expect, it } from 'vitest';
import {
  browserOriginFromPageUrl,
  canonicalBrowserOrigin,
  classifyBrowserHostname,
  isCredentialControl,
  normalizeBrowserUrl,
  projectBrowserUrl,
  sliceUtf8,
} from '../../../src/browser/BrowserSecurity.js';

describe('BrowserSecurity', () => {
  it('normalizes absolute HTTP(S) URLs and explicit effective ports', () => {
    expect(normalizeBrowserUrl('https://Example.com/path#fragment')).toMatchObject({
      href: 'https://example.com/path',
      origin: 'https://example.com:443',
      classification: 'public',
    });
    expect(normalizeBrowserUrl('http://localhost:4100/path')).toMatchObject({
      origin: 'http://localhost:4100',
      classification: 'loopback',
    });
    expect(canonicalBrowserOrigin(new URL('http://[::1]/'))).toBe('http://[::1]:80');
  });

  it.each([
    'file:///tmp/a',
    'data:text/plain,a',
    'javascript:alert(1)',
    'https://user:secret@example.com/',
    'example.com',
    '',
  ])('rejects unsupported navigation URL %s', (value) => {
    expect(() => normalizeBrowserUrl(value)).toThrow();
  });

  it('classifies loopback and private network hosts', () => {
    expect(classifyBrowserHostname('localhost')).toBe('loopback');
    expect(classifyBrowserHostname('app.localhost')).toBe('loopback');
    expect(classifyBrowserHostname('127.0.0.2')).toBe('loopback');
    expect(classifyBrowserHostname('::1')).toBe('loopback');
    expect(classifyBrowserHostname('10.0.0.1')).toBe('private-network');
    expect(classifyBrowserHostname('172.31.0.1')).toBe('private-network');
    expect(classifyBrowserHostname('192.168.1.1')).toBe('private-network');
    expect(classifyBrowserHostname('fc00::1')).toBe('private-network');
    expect(classifyBrowserHostname('example.com')).toBe('public');
    expect(classifyBrowserHostname('8.8.8.8')).toBe('public');
  });

  it('redacts query values and fragments from projected URLs', () => {
    const projected = projectBrowserUrl(
      'https://example.com/path?token=secret&name=blade&name=code#private'
    );
    expect(projected).toBe(
      'https://example.com/path?token=%5Bredacted%5D&name=%5Bredacted%5D&name=%5Bredacted%5D'
    );
    expect(projected).not.toContain('secret');
    expect(projected).not.toContain('private');
  });

  it('returns null for non-HTTP page origins', () => {
    expect(browserOriginFromPageUrl('about:blank')).toBeNull();
    expect(browserOriginFromPageUrl('data:text/plain,a')).toBeNull();
    expect(browserOriginFromPageUrl('https://example.com/a')).toBe(
      'https://example.com:443'
    );
  });

  it('slices UTF-8 without replacement characters', () => {
    expect(sliceUtf8('你好世界', 7)).toBe('你好');
  });

  it('detects credential controls deterministically', () => {
    expect(isCredentialControl({ type: 'PASSWORD' })).toBe(true);
    expect(
      isCredentialControl({ autocomplete: 'section-login current-password' })
    ).toBe(true);
    expect(isCredentialControl({ accessibleName: 'API KEY' })).toBe(true);
    expect(isCredentialControl({ ariaLabel: 'One\u3000Time Code' })).toBe(true);
    expect(isCredentialControl({ name: 'display-name' })).toBe(false);
    expect(isCredentialControl({ accessibleName: 'Project title' })).toBe(false);
  });

  it('fails credential classification closed for oversized identity fields', () => {
    expect(isCredentialControl({ id: 'x'.repeat(1025) })).toBe(true);
  });
});
