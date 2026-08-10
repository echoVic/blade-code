export function normalizeRuntimeEnvironment(
  environment: Readonly<Record<string, unknown>>
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`Invalid environment variable value: ${name}`);
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}
