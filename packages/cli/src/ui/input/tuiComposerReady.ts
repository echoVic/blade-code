const TUI_COMPOSER_READY_OSC_PREFIX = '\u001b]99;blade-composer-ready=';
const TUI_COMPOSER_READY_OSC_SUFFIX = '\u0007';

export const TUI_COMPOSER_READY_NONCE_ENV = 'BLADE_TUI_COMPOSER_READY_NONCE';

export function isTuiComposerReadyNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export function formatTuiComposerReadyMarker(nonce: string): string {
  if (!isTuiComposerReadyNonce(nonce)) {
    throw new Error('TUI composer ready nonce must be 32 lowercase hexadecimal chars');
  }
  return `${TUI_COMPOSER_READY_OSC_PREFIX}${nonce}${TUI_COMPOSER_READY_OSC_SUFFIX}`;
}

export function readTuiComposerReadyMarker(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const nonce = env[TUI_COMPOSER_READY_NONCE_ENV];
  if (!isTuiComposerReadyNonce(nonce)) {
    return undefined;
  }
  return formatTuiComposerReadyMarker(nonce);
}

export function emitTuiComposerReadyMarker(
  env: NodeJS.ProcessEnv = process.env,
  write: (value: string) => void = (value) => process.stdout.write(value)
): boolean {
  const marker = readTuiComposerReadyMarker(env);
  if (!marker) {
    return false;
  }
  write(marker);
  return true;
}
