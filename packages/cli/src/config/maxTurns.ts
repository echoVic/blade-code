export function isValidMaxTurns(value: number): boolean {
  return Number.isInteger(value) && (value === -1 || value >= 0);
}

export function formatMaxTurnsRange(): string {
  return `-1 (unlimited), 0 (disabled), or any positive integer`;
}
