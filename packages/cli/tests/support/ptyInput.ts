const DEFAULT_PTY_INPUT_CHUNK_BYTES = 1024;

export function chunkUtf8PtyInput(
  input: string,
  maximumBytes = DEFAULT_PTY_INPUT_CHUNK_BYTES
): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error('PTY input chunk size must be at least four bytes');
  }

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of input) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + characterBytes > maximumBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function writeBracketedPaste(
  terminal: { write(data: string): void },
  input: string
): Promise<void> {
  terminal.write('\u001B[200~');
  for (const chunk of chunkUtf8PtyInput(input)) {
    terminal.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  terminal.write('\u001B[201~');
}
