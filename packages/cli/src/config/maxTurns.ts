export const MAX_AGENT_TURNS = 100;

export function isValidMaxTurns(value: number): boolean {
  return Number.isInteger(value) && value >= -1 && value <= MAX_AGENT_TURNS;
}

export function formatMaxTurnsRange(): string {
  return `-1, 0, or an integer from 1 to ${MAX_AGENT_TURNS}`;
}
