import { formatUsd } from './money.js';

export class SpendCapExceeded extends Error {
  override name = 'SpendCapExceeded';
}

/**
 * One in-flight payment. Held from before the request until its outcome is known.
 *
 * The reservation exists because the moment a lookup is admitted is not the
 * moment we learn what it cost: a 404 releases the authorisation and costs
 * nothing, a 200 charges exactly the advertised price, and a 503 can leave the
 * outcome genuinely unknown. Counting the ceiling up front and reconciling
 * afterwards means concurrent tool calls can never collectively overrun the cap.
 */
export interface Reservation {
  readonly reservedAtomic: bigint;
  /** Settle for `actualAtomic` (default: the full reservation). Never more than reserved. */
  commit(actualAtomic?: bigint): void;
  /** Nothing was charged. Give it back. */
  release(): void;
}

export class SpendLedger {
  #spent = 0n;
  #reserved = 0n;
  #calls = 0;

  constructor(private readonly capAtomic: bigint) {
    if (capAtomic <= 0n) throw new RangeError('spend cap must be positive');
  }

  get spentAtomic(): bigint {
    return this.#spent;
  }

  get reservedAtomic(): bigint {
    return this.#reserved;
  }

  get capAtomicValue(): bigint {
    return this.capAtomic;
  }

  /** What could still be committed if every in-flight payment settles in full. */
  get remainingAtomic(): bigint {
    const remaining = this.capAtomic - this.#spent - this.#reserved;
    return remaining > 0n ? remaining : 0n;
  }

  get chargedCallCount(): number {
    return this.#calls;
  }

  reserve(atomic: bigint): Reservation {
    if (atomic <= 0n) throw new RangeError('reservation must be positive');
    if (this.#spent + this.#reserved + atomic > this.capAtomic) {
      throw new SpendCapExceeded(
        `this lookup would need up to USD ${formatUsd(atomic)} but only USD ` +
          `${formatUsd(this.remainingAtomic)} of the USD ${formatUsd(this.capAtomic)} ` +
          `SPEND_CAP_USD is left (USD ${formatUsd(this.#spent)} spent across ` +
          `${this.#calls} charged lookup${this.#calls === 1 ? '' : 's'}` +
          (this.#reserved > 0n ? `, USD ${formatUsd(this.#reserved)} in flight` : '') +
          '). Restart the server with a higher SPEND_CAP_USD to continue.',
      );
    }
    this.#reserved += atomic;

    let settled = false;
    const ledger = this;
    return {
      reservedAtomic: atomic,
      commit(actualAtomic?: bigint): void {
        if (settled) return;
        settled = true;
        const charged = actualAtomic === undefined || actualAtomic > atomic ? atomic : actualAtomic;
        ledger.#reserved -= atomic;
        ledger.#spent += charged;
        if (charged > 0n) ledger.#calls += 1;
      },
      release(): void {
        if (settled) return;
        settled = true;
        ledger.#reserved -= atomic;
      },
    };
  }

  /** A one-line summary safe to put in a tool result. Contains no key material. */
  summary(): string {
    return (
      `spent USD ${formatUsd(this.#spent)} of the USD ${formatUsd(this.capAtomic)} cap ` +
      `over ${this.#calls} charged lookup${this.#calls === 1 ? '' : 's'}; ` +
      `USD ${formatUsd(this.remainingAtomic)} remaining`
    );
  }
}
