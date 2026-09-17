import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AcpRemotePathError,
  type AcpRemotePathErrorReason,
  createAcpRemotePathProfile,
  inferAcpRemotePathStyle,
  normalizeAcpRemotePath,
  parseAcpRemotePath,
  resolveAcpRemotePathDescendant,
} from '../../../../src/acp/AcpRemotePath.js';
import invalidRemotePaths from '../../../fixtures/acpInvalidRemotePaths.json';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactIdentity(style: 'posix' | 'win32', wirePath: string) {
  return `acp-remote-exact-path:${sha256(`${style}\0${wirePath}`)}` as const;
}

function collisionIdentity(style: 'posix' | 'win32', collisionForm: string) {
  return `acp-remote-collision-path:${sha256(`${style}\0${collisionForm}`)}` as const;
}

describe('AcpRemotePath', () => {
  it('infers path style from absolute remote syntax', () => {
    expect(inferAcpRemotePathStyle('/repo/src/file.ts')).toBe('posix');
    expect(inferAcpRemotePathStyle('c:/Repo/file.ts')).toBe('win32');
    expect(inferAcpRemotePathStyle('C:\\Repo\\file.ts')).toBe('win32');
  });

  it('creates a typed workspace profile from a remote root', () => {
    expect(createAcpRemotePathProfile('c:/Repo')).toEqual({
      style: 'win32',
      workspace: {
        style: 'win32',
        wirePath: 'C:\\Repo',
        exactIdentity: exactIdentity('win32', 'C:\\Repo'),
        collisionIdentity: collisionIdentity('win32', 'C:\\REPO'),
      },
    });
  });

  it('parses win32 paths with exact wire normalization and collision hashing', () => {
    const windowsStyle = createAcpRemotePathProfile('c:/Repo').style;
    const mixedSeparators = parseAcpRemotePath('C:\\Repo\\ΟΣ.ts', windowsStyle);
    const lowercaseDrive = parseAcpRemotePath('c:/repo/οσ.ts', windowsStyle);

    expect(mixedSeparators.wirePath).toBe('C:\\Repo\\ΟΣ.ts');
    expect(lowercaseDrive.wirePath).toBe('C:\\repo\\οσ.ts');
    expect(mixedSeparators.exactIdentity).toBe(
      exactIdentity('win32', 'C:\\Repo\\ΟΣ.ts')
    );
    expect(lowercaseDrive.exactIdentity).toBe(
      exactIdentity('win32', 'C:\\repo\\οσ.ts')
    );
    expect(mixedSeparators.exactIdentity).not.toBe(lowercaseDrive.exactIdentity);
    expect(mixedSeparators.collisionIdentity).toBe(
      collisionIdentity('win32', 'C:\\REPO\\ΟΣ.TS')
    );
    expect(lowercaseDrive.collisionIdentity).toBe(
      collisionIdentity('win32', 'C:\\REPO\\ΟΣ.TS')
    );
    expect(mixedSeparators.collisionIdentity).toBe(lowercaseDrive.collisionIdentity);
  });

  it('uses ECMAScript uppercase for conservative win32 collision identities', () => {
    const dotted = parseAcpRemotePath('C:\\Repo\\i.ts', 'win32');
    const upper = parseAcpRemotePath('C:\\Repo\\I.ts', 'win32');
    const dotless = parseAcpRemotePath('C:\\Repo\\ı.ts', 'win32');

    expect(dotted.exactIdentity).not.toBe(upper.exactIdentity);
    expect(dotless.exactIdentity).not.toBe(upper.exactIdentity);
    expect(dotted.collisionIdentity).toBe(collisionIdentity('win32', 'C:\\REPO\\I.TS'));
    expect(upper.collisionIdentity).toBe(collisionIdentity('win32', 'C:\\REPO\\I.TS'));
    expect(dotless.collisionIdentity).toBe(
      collisionIdentity('win32', 'C:\\REPO\\I.TS')
    );
  });

  it('preserves POSIX case, unicode normalization, colon, and ordinary backslash distinctions', () => {
    const nfc = parseAcpRemotePath('/repo/é:file\\name.ts', 'posix');
    const nfd = parseAcpRemotePath('/repo/e\u0301:file\\name.ts', 'posix');
    const upper = parseAcpRemotePath('/repo/File.ts', 'posix');
    const lower = parseAcpRemotePath('/repo/file.ts', 'posix');

    expect(nfc.wirePath).toBe('/repo/é:file\\name.ts');
    expect(nfd.wirePath).toBe('/repo/e\u0301:file\\name.ts');
    expect(upper.exactIdentity).not.toBe(lower.exactIdentity);
    expect(upper.collisionIdentity).not.toBe(lower.collisionIdentity);
    expect(nfc.exactIdentity).not.toBe(nfd.exactIdentity);
    expect(nfc.collisionIdentity).not.toBe(nfd.collisionIdentity);
  });

  it('resolves descendants lexically without host filesystem helpers', () => {
    expect(resolveAcpRemotePathDescendant('c:/Repo', 'src/../ΟΣ.ts')).toEqual({
      style: 'win32',
      wirePath: 'C:\\Repo\\ΟΣ.ts',
      exactIdentity: exactIdentity('win32', 'C:\\Repo\\ΟΣ.ts'),
      collisionIdentity: collisionIdentity('win32', 'C:\\REPO\\ΟΣ.TS'),
    });

    expect(resolveAcpRemotePathDescendant('/repo', 'dir/../a:b\\c')).toEqual({
      style: 'posix',
      wirePath: '/repo/a:b\\c',
      exactIdentity: exactIdentity('posix', '/repo/a:b\\c'),
      collisionIdentity: collisionIdentity('posix', '/repo/a:b\\c'),
    });

    expect(resolveAcpRemotePathDescendant('/repo', 'a:b')).toEqual({
      style: 'posix',
      wirePath: '/repo/a:b',
      exactIdentity: exactIdentity('posix', '/repo/a:b'),
      collisionIdentity: collisionIdentity('posix', '/repo/a:b'),
    });

    expect(resolveAcpRemotePathDescendant('/repo', 'C:secret')).toEqual({
      style: 'posix',
      wirePath: '/repo/C:secret',
      exactIdentity: exactIdentity('posix', '/repo/C:secret'),
      collisionIdentity: collisionIdentity('posix', '/repo/C:secret'),
    });
  });

  it('rejects dangerous descendant relative forms without leaking input', () => {
    const invalidCases: ReadonlyArray<{
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly reason: AcpRemotePathErrorReason;
      readonly style: 'posix' | 'win32';
    }> = [
      {
        workspaceRoot: '/repo',
        relativePath: '../secret.txt',
        reason: 'not-absolute',
        style: 'posix',
      },
      {
        workspaceRoot: 'c:/Repo',
        relativePath: '..\\secret.txt',
        reason: 'not-absolute',
        style: 'win32',
      },
      {
        workspaceRoot: 'c:/Repo',
        relativePath: 'C:secret.txt',
        reason: 'drive-relative',
        style: 'win32',
      },
      {
        workspaceRoot: 'c:/Repo',
        relativePath: 'file.txt::$DATA',
        reason: 'alternate-data-stream',
        style: 'win32',
      },
    ];

    for (const testCase of invalidCases) {
      try {
        resolveAcpRemotePathDescendant(testCase.workspaceRoot, testCase.relativePath);
        throw new Error('expected descendant resolution to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AcpRemotePathError);
        if (!(error instanceof AcpRemotePathError)) {
          throw error;
        }

        const serialized = JSON.stringify(error);
        expect(error.reason).toBe(testCase.reason);
        expect(error.style).toBe(testCase.style);
        expect(error.message).not.toContain(testCase.relativePath);
        expect(serialized).not.toContain(testCase.relativePath);
      }
    }
  });

  it('keeps normalize compatibility through the new parser', () => {
    expect(normalizeAcpRemotePath('/workspace/src/../src/file.ts')).toBe(
      '/workspace/src/file.ts'
    );
    expect(normalizeAcpRemotePath('c:/workspace/src/../file.ts')).toBe(
      'C:\\workspace\\file.ts'
    );
    expect(normalizeAcpRemotePath('c:\\workspace\\src\\..\\file.ts')).toBe(
      'C:\\workspace\\file.ts'
    );
  });

  it('rejects invalid absolute forms with typed reasons', () => {
    const invalidCases: ReadonlyArray<{
      readonly label: string;
      readonly input: string;
      readonly expectedStyle?: 'posix' | 'win32';
      readonly reason: AcpRemotePathErrorReason;
      readonly style: 'unknown' | 'posix' | 'win32';
    }> = invalidRemotePaths as ReadonlyArray<{
      readonly label: string;
      readonly input: string;
      readonly expectedStyle?: 'posix' | 'win32';
      readonly reason: AcpRemotePathErrorReason;
      readonly style: 'unknown' | 'posix' | 'win32';
    }>;

    for (const testCase of invalidCases) {
      expect(() =>
        parseAcpRemotePath(testCase.input, testCase.expectedStyle)
      ).toThrowError(
        expect.objectContaining({
          name: 'AcpRemotePathError',
          code: 'acp_remote_path_invalid',
          reason: testCase.reason,
          style: testCase.style,
        })
      );
    }
  });

  it('keeps error message and json serialization redacted', () => {
    const rawPath = 'C:\\Repo\\Secret Name\\NUL.txt';

    try {
      parseAcpRemotePath(rawPath);
      throw new Error('expected parseAcpRemotePath to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AcpRemotePathError);
      if (!(error instanceof AcpRemotePathError)) {
        throw error;
      }
      const serialized = JSON.stringify(error);

      expect(error.reason).toBe('reserved-device-name');
      expect(error.message).not.toContain(rawPath);
      expect(error.message).not.toContain('NUL.txt');
      expect(serialized).not.toContain(rawPath);
      expect(serialized).not.toContain('NUL.txt');
      expect(serialized).toContain('reserved-device-name');
      expect(serialized).toContain('win32');
    }
  });
});
