const MIN_INTERVAL_MS = 120_000;
const MIN_ROUNDS = 5;

/** Run-owned scheduling: failures consume the same cooldown as successful recaps. */
export class ConversationRecapSchedule {
  private lastRound = 0;

  constructor(private lastAttemptAt: number) {}

  claim(completedRounds: number, now: number, compacted = false): boolean {
    if (now - this.lastAttemptAt < MIN_INTERVAL_MS) return false;
    if (completedRounds <= this.lastRound) return false;
    if (!compacted && completedRounds - this.lastRound < MIN_ROUNDS) return false;
    this.lastRound = completedRounds;
    this.lastAttemptAt = now;
    return true;
  }
}
