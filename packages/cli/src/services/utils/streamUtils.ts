export function isStreamUsageUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('stream_options') ||
    message.includes('include_usage') ||
    message.includes('unknown parameter') ||
    message.includes('unrecognized request argument')
  );
}
