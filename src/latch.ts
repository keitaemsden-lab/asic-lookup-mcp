/**
 * A short refusal on repeating a query whose payment outcome was never learnt.
 *
 * When a lookup ends with `charged: "unknown"` the honest advice is "do not
 * retry this exact query until the authorisation has expired" -- but the driver
 * here is a model in a loop, and advice in prose is not a control. This is the
 * control: the identical query is refused until the signature it already
 * produced can no longer be settled, so a retry loop cannot turn one uncertain
 * charge into ten certain ones.
 *
 * Keyed on the query, not on the tool call, because the retry a model reaches
 * for is the same query again.
 */
export class RetryLatch {
  #held = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds still to wait on this query, or null if it is free to run. */
  heldMs(key: string): number | null {
    const until = this.#held.get(key);
    if (until === undefined) return null;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.#held.delete(key);
      return null;
    }
    return remaining;
  }

  /** Refuse this query for `forMs`, or leave the existing hold if it is longer. */
  hold(key: string, forMs: number): void {
    const nowMs = this.now();
    // Expired holds are dropped when the same query is asked again, which is
    // never for a query that is never repeated. Sweep here too, so a long-lived
    // process cannot accumulate one entry per distinct query that ever failed.
    for (const [held, until] of this.#held) {
      if (until <= nowMs) this.#held.delete(held);
    }
    const until = this.now() + forMs;
    const existing = this.#held.get(key);
    if (existing === undefined || until > existing) this.#held.set(key, until);
  }
}
