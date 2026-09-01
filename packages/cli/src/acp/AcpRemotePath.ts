import { createHash } from 'node:crypto';

export type AcpRemotePathStyle = 'posix' | 'win32';

export interface AcpRemotePath {
  readonly style: AcpRemotePathStyle;
  readonly wirePath: string;
  readonly exactIdentity: `acp-remote-exact-path:${string}`;
  readonly collisionIdentity: `acp-remote-collision-path:${string}`;
}

export interface AcpRemotePathProfile {
  readonly style: AcpRemotePathStyle;
  readonly workspace: AcpRemotePath;
}

const canonicalRemotePaths = new WeakSet<object>();
const canonicalRemotePathProfiles = new WeakSet<object>();

export type AcpRemotePathErrorReason =
  | 'not-absolute'
  | 'style-mismatch'
  | 'drive-relative'
  | 'root-relative'
  | 'unc-not-supported'
  | 'device-namespace-not-supported'
  | 'trailing-dot-or-space'
  | 'alternate-data-stream'
  | 'reserved-device-name'
  | 'short-name-alias'
  | 'invalid-character';

const ACP_REMOTE_PATH_ERROR_MESSAGES: Record<AcpRemotePathErrorReason, string> = {
  'not-absolute': 'ACP remote file path must be absolute',
  'style-mismatch': 'ACP remote file path does not match the expected style',
  'drive-relative': 'ACP remote file path cannot be drive-relative',
  'root-relative': 'ACP remote file path cannot be root-relative',
  'unc-not-supported':
    'ACP remote file path must be absolute; UNC paths are not supported',
  'device-namespace-not-supported':
    'ACP remote file path device namespaces are not supported',
  'trailing-dot-or-space':
    'ACP remote file path components cannot end with a dot or space',
  'alternate-data-stream':
    'ACP remote file path alternate data streams are not supported',
  'reserved-device-name':
    'ACP remote file path reserved device names are not supported',
  'short-name-alias': 'ACP remote file path short-name aliases are not supported',
  'invalid-character':
    'ACP remote file path contains characters that are not supported',
};

const WIN32_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'COM¹',
  'COM²',
  'COM³',
  'LPT¹',
  'LPT²',
  'LPT³',
]);

interface PathClassificationAbsolute {
  readonly kind: 'absolute';
  readonly style: AcpRemotePathStyle;
}

interface PathClassificationError {
  readonly kind: 'error';
  readonly reason: AcpRemotePathErrorReason;
  readonly style: AcpRemotePathStyle | 'unknown';
}

type PathClassification = PathClassificationAbsolute | PathClassificationError;

export class AcpRemotePathError extends Error {
  readonly name = 'AcpRemotePathError';
  readonly code = 'acp_remote_path_invalid';

  constructor(
    readonly reason: AcpRemotePathErrorReason,
    readonly style: AcpRemotePathStyle | 'unknown'
  ) {
    super(ACP_REMOTE_PATH_ERROR_MESSAGES[reason]);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): {
    readonly name: 'AcpRemotePathError';
    readonly code: 'acp_remote_path_invalid';
    readonly reason: AcpRemotePathErrorReason;
    readonly style: AcpRemotePathStyle | 'unknown';
    readonly message: string;
  } {
    return {
      name: this.name,
      code: this.code,
      reason: this.reason,
      style: this.style,
      message: this.message,
    };
  }
}

export class AcpRemotePathIdentityError extends Error {
  readonly name = 'AcpRemotePathIdentityError';
  readonly code = 'acp_remote_path_identity_invalid';

  constructor() {
    super('ACP remote path identity is invalid');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function assertCanonicalAcpRemotePath(remotePath: AcpRemotePath): void {
  if (!canonicalRemotePaths.has(remotePath)) {
    throw new AcpRemotePathIdentityError();
  }
}

export function assertCanonicalAcpRemotePathProfile(
  profile: AcpRemotePathProfile
): void {
  if (!canonicalRemotePathProfiles.has(profile)) {
    throw new AcpRemotePathIdentityError();
  }
  assertCanonicalAcpRemotePath(profile.workspace);
  if (profile.style !== profile.workspace.style) {
    throw new AcpRemotePathIdentityError();
  }
}

export function cloneAcpRemotePathProfile(
  profile: AcpRemotePathProfile
): AcpRemotePathProfile {
  assertCanonicalAcpRemotePathProfile(profile);
  const clonedProfile: AcpRemotePathProfile = Object.freeze({
    style: profile.style,
    workspace: profile.workspace,
  });
  canonicalRemotePathProfiles.add(clonedProfile);
  return clonedProfile;
}

export function inferAcpRemotePathStyle(path: string): AcpRemotePathStyle {
  const classification = classifyAcpRemotePath(path);

  if (classification.kind === 'error') {
    throw new AcpRemotePathError(classification.reason, classification.style);
  }

  return classification.style;
}

export function createAcpRemotePathProfile(root: string): AcpRemotePathProfile {
  const workspace = parseAcpRemotePath(root);
  const profile: AcpRemotePathProfile = Object.freeze({
    style: workspace.style,
    workspace,
  });
  canonicalRemotePathProfiles.add(profile);
  return profile;
}

export function parseAcpRemotePath(
  filePath: string,
  expectedStyle?: AcpRemotePathStyle
): AcpRemotePath {
  const classification = classifyAcpRemotePath(filePath, expectedStyle);

  if (classification.kind === 'error') {
    throw new AcpRemotePathError(classification.reason, classification.style);
  }

  const wirePath =
    classification.style === 'win32'
      ? normalizeWin32AbsolutePath(filePath)
      : normalizePosixAbsolutePath(filePath);

  return createAcpRemotePath(classification.style, wirePath);
}

export function resolveAcpRemotePathDescendant(
  workspaceRoot: string,
  relativePath: string
): AcpRemotePath {
  const workspace = parseAcpRemotePath(workspaceRoot);
  const descendantWirePath =
    workspace.style === 'win32'
      ? resolveWin32DescendantChecked(workspace.wirePath, relativePath)
      : resolvePosixDescendantChecked(workspace.wirePath, relativePath);

  return createAcpRemotePath(workspace.style, descendantWirePath);
}

export function normalizeAcpRemotePath(filePath: string): string {
  return parseAcpRemotePath(filePath).wirePath;
}

function classifyAcpRemotePath(
  filePath: string,
  expectedStyle?: AcpRemotePathStyle
): PathClassification {
  if (isWin32DeviceNamespace(filePath)) {
    return {
      kind: 'error',
      reason: 'device-namespace-not-supported',
      style: 'win32',
    };
  }

  if (isPosixNamespaceAmbiguous(filePath)) {
    return {
      kind: 'error',
      reason: 'unc-not-supported',
      style: expectedStyle === 'posix' ? 'posix' : 'win32',
    };
  }

  if (isWin32UncNamespace(filePath)) {
    return {
      kind: 'error',
      reason: 'unc-not-supported',
      style: 'win32',
    };
  }

  if (isWin32DriveAbsolute(filePath)) {
    if (expectedStyle === 'posix') {
      return {
        kind: 'error',
        reason: 'style-mismatch',
        style: 'posix',
      };
    }

    return {
      kind: 'absolute',
      style: 'win32',
    };
  }

  if (isWin32DriveRelative(filePath)) {
    return {
      kind: 'error',
      reason: 'drive-relative',
      style: 'win32',
    };
  }

  if (filePath.startsWith('\\')) {
    return {
      kind: 'error',
      reason: 'root-relative',
      style: 'win32',
    };
  }

  if (filePath.startsWith('/')) {
    if (expectedStyle === 'win32') {
      return {
        kind: 'error',
        reason: 'style-mismatch',
        style: 'win32',
      };
    }

    return {
      kind: 'absolute',
      style: 'posix',
    };
  }

  return {
    kind: 'error',
    reason: 'not-absolute',
    style: 'unknown',
  };
}

function createAcpRemotePath(
  style: AcpRemotePathStyle,
  wirePath: string
): AcpRemotePath {
  const collisionForm = style === 'win32' ? wirePath.toUpperCase() : wirePath;

  const remotePath: AcpRemotePath = Object.freeze({
    style,
    wirePath,
    exactIdentity: hashIdentity('acp-remote-exact-path', style, wirePath),
    collisionIdentity: hashIdentity('acp-remote-collision-path', style, collisionForm),
  });
  canonicalRemotePaths.add(remotePath);
  return remotePath;
}

function hashIdentity<
  TPrefix extends 'acp-remote-exact-path' | 'acp-remote-collision-path',
>(prefix: TPrefix, style: AcpRemotePathStyle, value: string): `${TPrefix}:${string}` {
  return `${prefix}:${createHash('sha256').update(`${style}\0${value}`).digest('hex')}`;
}

function normalizePosixAbsolutePath(filePath: string): string {
  const segments = filePath.split('/');
  const normalized: string[] = [];

  for (const segment of segments.slice(1)) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (normalized.length > 0) {
        normalized.pop();
      }
      continue;
    }

    validatePosixSegment(segment);
    normalized.push(segment);
  }

  return normalized.length === 0 ? '/' : `/${normalized.join('/')}`;
}

function normalizeWin32AbsolutePath(filePath: string): string {
  const driveLetter = filePath[0]!.toUpperCase();
  const trailingSeparator = endsWithWin32Separator(filePath);
  const normalized: string[] = [];
  let segment = '';

  for (const character of filePath.slice(2)) {
    if (isWin32Separator(character)) {
      if (segment.length > 0) {
        appendWin32Segment(normalized, segment);
        segment = '';
      }
      continue;
    }

    segment += character;
  }

  if (segment.length > 0) {
    appendWin32Segment(normalized, segment);
  }

  if (trailingSeparator && normalized.length > 0) {
    throw new AcpRemotePathError('trailing-dot-or-space', 'win32');
  }

  if (normalized.length === 0) {
    return `${driveLetter}:\\`;
  }

  return `${driveLetter}:\\${normalized.join('\\')}`;
}

function resolvePosixDescendant(
  workspaceWirePath: string,
  relativePath: string
): string {
  const workspaceSegments =
    workspaceWirePath === '/' ? [] : workspaceWirePath.slice(1).split('/');
  const descendantSegments = [...workspaceSegments];

  for (const segment of relativePath.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (descendantSegments.length === workspaceSegments.length) {
        throw new AcpRemotePathError('not-absolute', 'posix');
      }
      descendantSegments.pop();
      continue;
    }

    validatePosixSegment(segment);
    descendantSegments.push(segment);
  }

  return descendantSegments.length === 0 ? '/' : `/${descendantSegments.join('/')}`;
}

function resolvePosixDescendantChecked(
  workspaceWirePath: string,
  relativePath: string
): string {
  if (isWin32DeviceNamespace(relativePath)) {
    throw new AcpRemotePathError('device-namespace-not-supported', 'win32');
  }

  if (isPosixNamespaceAmbiguous(relativePath)) {
    throw new AcpRemotePathError('unc-not-supported', 'posix');
  }

  if (isWin32UncNamespace(relativePath)) {
    throw new AcpRemotePathError('unc-not-supported', 'win32');
  }

  if (isWin32DriveAbsolute(relativePath) || relativePath.startsWith('/')) {
    throw new AcpRemotePathError('style-mismatch', 'posix');
  }

  return resolvePosixDescendant(workspaceWirePath, relativePath);
}

function resolveWin32Descendant(
  workspaceWirePath: string,
  relativePath: string
): string {
  const baseIndex = workspaceWirePath.indexOf('\\');
  const workspaceSegments =
    baseIndex === workspaceWirePath.length - 1
      ? []
      : workspaceWirePath.slice(baseIndex + 1).split('\\');
  const descendantSegments = [...workspaceSegments];
  let segment = '';

  for (const character of relativePath) {
    if (isWin32Separator(character)) {
      if (segment.length > 0) {
        applyWin32DescendantSegment(
          workspaceSegments.length,
          descendantSegments,
          segment
        );
        segment = '';
      }
      continue;
    }

    segment += character;
  }

  if (segment.length > 0) {
    applyWin32DescendantSegment(workspaceSegments.length, descendantSegments, segment);
  }

  const driveRoot = workspaceWirePath.slice(0, baseIndex + 1);
  if (descendantSegments.length === 0) {
    return driveRoot;
  }

  return `${driveRoot}${descendantSegments.join('\\')}`;
}

function resolveWin32DescendantChecked(
  workspaceWirePath: string,
  relativePath: string
): string {
  const relativeClassification = classifyAcpRemotePath(relativePath, 'win32');

  if (relativeClassification.kind === 'absolute') {
    throw new AcpRemotePathError('style-mismatch', 'win32');
  }

  if (relativeClassification.reason !== 'not-absolute') {
    throw new AcpRemotePathError(
      relativeClassification.reason,
      relativeClassification.style
    );
  }

  return resolveWin32Descendant(workspaceWirePath, relativePath);
}

function applyWin32DescendantSegment(
  workspaceDepth: number,
  descendantSegments: string[],
  segment: string
): void {
  if (segment === '.') {
    return;
  }

  if (segment === '..') {
    if (descendantSegments.length === workspaceDepth) {
      throw new AcpRemotePathError('not-absolute', 'win32');
    }
    descendantSegments.pop();
    return;
  }

  validateWin32Segment(segment);
  descendantSegments.push(segment);
}

function appendWin32Segment(segments: string[], segment: string): void {
  if (segment === '.') {
    return;
  }

  if (segment === '..') {
    if (segments.length > 0) {
      segments.pop();
    }
    return;
  }

  validateWin32Segment(segment);
  segments.push(segment);
}

function validatePosixSegment(segment: string): void {
  if (segment.includes('\0')) {
    throw new AcpRemotePathError('invalid-character', 'posix');
  }
}

function validateWin32Segment(segment: string): void {
  const trimmedComponent = trimWin32TrailingDotsAndSpaces(segment);
  const reservedStem = getWin32ReservedStem(trimmedComponent);

  if (
    reservedStem !== undefined &&
    WIN32_RESERVED_DEVICE_NAMES.has(reservedStem.toUpperCase())
  ) {
    throw new AcpRemotePathError('reserved-device-name', 'win32');
  }

  if (trimmedComponent !== segment) {
    throw new AcpRemotePathError('trailing-dot-or-space', 'win32');
  }

  if (segment.includes(':')) {
    throw new AcpRemotePathError('alternate-data-stream', 'win32');
  }

  if (/~\d/u.test(segment)) {
    throw new AcpRemotePathError('short-name-alias', 'win32');
  }

  for (const character of segment) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint === undefined ||
      codePoint === 0 ||
      (codePoint >= 0x01 && codePoint <= 0x1f) ||
      '<>"|?*'.includes(character)
    ) {
      throw new AcpRemotePathError('invalid-character', 'win32');
    }
  }
}

function trimWin32TrailingDotsAndSpaces(component: string): string {
  let end = component.length;

  while (end > 0) {
    const character = component[end - 1];
    if (character !== '.' && character !== ' ') {
      break;
    }
    end -= 1;
  }

  return component.slice(0, end);
}

function getWin32ReservedStem(component: string): string | undefined {
  if (component.length === 0) {
    return undefined;
  }

  const dotIndex = component.indexOf('.');
  return dotIndex === -1 ? component : component.slice(0, dotIndex);
}

function isPosixNamespaceAmbiguous(filePath: string): boolean {
  return filePath.startsWith('//') || filePath.startsWith('/\\');
}

function isWin32DeviceNamespace(filePath: string): boolean {
  return /^([\\/]){2}[?.][\\/]/u.test(filePath);
}

function isWin32UncNamespace(filePath: string): boolean {
  return /^[\\/]{2}/u.test(filePath);
}

function isWin32DriveAbsolute(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(filePath);
}

function isWin32DriveRelative(filePath: string): boolean {
  return /^[A-Za-z]:(?![\\/])/u.test(filePath);
}

function isWin32Separator(character: string): boolean {
  return character === '\\' || character === '/';
}

function endsWithWin32Separator(filePath: string): boolean {
  if (filePath.length <= 3) {
    return false;
  }

  const lastCharacter = filePath[filePath.length - 1];
  return lastCharacter === '\\' || lastCharacter === '/';
}
