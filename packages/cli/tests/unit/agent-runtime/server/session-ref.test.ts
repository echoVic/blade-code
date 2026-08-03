import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeSessionRef,
  sameSessionRef,
  sessionRefKey,
  type SessionRef,
} from '../../../../src/server/sessionRef.js';

describe('sessionRef helpers', () => {
  it('rejects invalid session ids before generating keys', () => {
    expect(() =>
      normalizeSessionRef({
        sessionId: '../escape',
        projectPath: '/tmp/workspace',
      })
    ).toThrow('Invalid session ID');
  });

  it('rejects relative project paths', () => {
    expect(() =>
      normalizeSessionRef({
        sessionId: 'session-1',
        projectPath: './relative-workspace',
      })
    ).toThrow('projectPath must be absolute');
  });

  it('normalizes absolute paths consistently', () => {
    const projectPath = path.join('/tmp', 'workspace', '..', 'workspace', '.');

    expect(normalizeSessionRef({ sessionId: 'session-1', projectPath })).toEqual({
      sessionId: 'session-1',
      projectPath: path.resolve('/tmp/workspace'),
    });
  });

  it('treats equivalent normalized refs as equal', () => {
    const left: SessionRef = {
      sessionId: 'session-1',
      projectPath: '/tmp/a/../workspace',
    };
    const right: SessionRef = {
      sessionId: 'session-1',
      projectPath: '/tmp/workspace',
    };

    expect(sameSessionRef(left, right)).toBe(true);
  });

  it('generates different keys for the same session id in different workspaces', () => {
    const left = sessionRefKey({
      sessionId: 'shared-id',
      projectPath: '/tmp/workspace-a',
    });
    const right = sessionRefKey({
      sessionId: 'shared-id',
      projectPath: '/tmp/workspace-b',
    });

    expect(left).not.toBe(right);
  });

  it('uses an unambiguous JSON array key encoding', () => {
    const ref: SessionRef = {
      sessionId: 'session.with-delimiters',
      projectPath: '/tmp/workspace-with|delimiters',
    };

    expect(sessionRefKey(ref)).toBe(
      JSON.stringify([path.resolve(ref.projectPath), ref.sessionId])
    );
  });
});
