import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  deriveSessionTitleFromContent,
  flattenMessageText,
} from '../../../src/api/sessionTitle.js';

describe('deriveSessionTitle', () => {
  it('uses the first line/sentence of the message as the headline', () => {
    expect(deriveSessionTitle('Fix the login redirect bug. It fails on Safari.')).toBe(
      'Fix the login redirect bug'
    );
  });

  it('collapses whitespace and newlines', () => {
    expect(deriveSessionTitle('  Add\n\n  dark   mode   toggle  ')).toBe(
      'Add dark mode toggle'
    );
  });

  it('strips system-reminder and file wrappers', () => {
    const raw =
      '<system-reminder>ignore me</system-reminder>Refactor the parser module';
    expect(deriveSessionTitle(raw)).toBe('Refactor the parser module');
  });

  it('drops a leading slash command but keeps the intent', () => {
    expect(deriveSessionTitle('/goal ship the release pipeline')).toBe(
      'ship the release pipeline'
    );
  });

  it('truncates long input on a word boundary with an ellipsis', () => {
    const long =
      'Implement a fully featured production grade authentication system with refresh tokens and rotation';
    const title = deriveSessionTitle(long);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('Implement a fully featured')).toBe(true);
  });

  it('returns empty string for whitespace-only or tag-only input', () => {
    expect(deriveSessionTitle('   ')).toBe('');
    expect(deriveSessionTitle('<system-reminder>x</system-reminder>')).toBe('');
  });

  it('handles CJK sentence boundaries', () => {
    expect(deriveSessionTitle('优化侧边栏的项目分组交互。顺便修一下滚动。')).toBe(
      '优化侧边栏的项目分组交互'
    );
  });
});

describe('flattenMessageText / deriveSessionTitleFromContent', () => {
  it('flattens content-part arrays, ignoring images', () => {
    const content = [
      { type: 'text', text: 'Analyze this screenshot' },
      { type: 'image_url', image_url: { url: 'data:...' } },
    ];
    expect(flattenMessageText(content).trim()).toBe('Analyze this screenshot');
    expect(deriveSessionTitleFromContent(content)).toBe('Analyze this screenshot');
  });

  it('passes through plain strings', () => {
    expect(deriveSessionTitleFromContent('Just a string task')).toBe(
      'Just a string task'
    );
  });
});
