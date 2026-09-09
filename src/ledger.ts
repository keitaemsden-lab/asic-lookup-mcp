import { formatUsd } from './money.js';

export class SpendCapExceeded extends Error {
  override name = 'SpendCapExceeded';
}

/**
 * One EIP-3009 authorisation this process has signed and handed to a payee.
 *
 * `atomic` is the value inside the signature, not the price the response
 * reported: the two are only the same when the payee is honest.
 */
export interface SignedAuthorisation {
  readonly atomic: bigint;
  /** Epoch milliseconds after which the signature can no longer be settled. */
  readonly expiresAtMs: number;
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
  /**
   * Record that a signature for this lookup now exists in the payee's hands.
   *
   * Called from the x402 client's `onAfterPaymentCreation` hook, before the
   * paid request is even sent. Everything the ledger does afterwards is
   * accounted against this, not against what the response claims.
   */
  noteSignature(signature: SignedAuthorisation): void;
  /**
   * Settle for `actualAtomic` (default: the full reservation).
   *
   * Never more than reserved, and never less than what was signed: the payee
   * reports the price, but the payee is also the party that benefits from
   * under-reporting it.
   */
  commit(actualAtomic?: bigint): void;
  /**
   * The payee says it settled nothing.
   *
   * The reservation comes back, but any signature already handed over does not:
   * a release is the payee's promise not to settle, and a promise is not a
   * revocation. The signed amount stays held against the cap as outstanding
   * exposure until its `validBefore` passes.
   */
  release(): void;
  /**
   * Settle however the signatures say to, if nothing has settled this yet.
   *
   * The `finally` path: a body read that throws, or any other escape that skips
   * both explicit outcomes, must not leave the reservation held forever.
   */
  settleDefault(): void;
}

export class SpendLedger {
  #spent = 0n;
  #reserved = 0n;
  #calls = 0;
  #outstanding: SignedAuthorisation[] = [];

  /**
   * @param capAtomic - the cumulative ceiling, in atomic USDC units
   * @param now - clock, injectable so a test can watch an authorisation expire
   */
  constructor(
    private readonly capAtomic: bigint,
    private readonly now: () => number = Date.now,
  ) {
    if (capAtomic <= 0n) throw new RangeError('spend cap must be positive');
  }

  get spentAtomic(): bigint {
    return this.#spent;
  }

  get reservedAtomic(): bigint {
    return this.#reserved;
  }

  /**
   * Signed authorisations that were not charged and have not yet expired.
   *
   * Money that has not moved and may never move, but that this process has
   * already made spendable by someone else. It is held against the cap because
   * the alternative -- counting a "free" miss as free -- is what let an agent
   * hand out USD 100 of live authorisations against a USD 1.00 cap.
   */
  get outstandingAtomic(): bigint {
    this.#sweep();
    let total = 0n;
    for (const authorisation of this.#outstanding) total += authorisation.atomic;
    return total;
  }

  get capAtomicValue(): bigint {
    return this.capAtomic;
  }

  /** What could still be committed if every in-flight payment settles in full. */
  get remainingAtomic(): bigint {
    const remaining = this.capAtomic - this.#spent - this.#reserved - this.outstandingAtomic;
    return remaining > 0n ? remaining : 0n;
  }

  get chargedCallCount(): number {
    return this.#calls;
  }

  /** Drop authorisations whose validBefore has passed: they can no longer be settled. */
  #sweep(): void {
    if (this.#outstanding.length === 0) return;
    const nowMs = this.now();
    this.#outstanding = this.#outstanding.filter((entry) => entry.expiresAtMs > nowMs);
  }

  #hold(atomic: bigint, expiresAtMs: number): void {
    if (atomic <= 0n) return;
    this.#outstanding.push({ atomic, expiresAtMs });
  }

  reserve(atomic: bigint): Reservation {
    if (atomic <= 0n) throw new RangeError('reservation must be positive');
    const outstanding = this.outstandingAtomic;
    if (this.#spent + this.#reserved + outstanding + atomic > this.capAtomic) {
      throw new SpendCapExceeded(
        `this lookup would need up to USD ${formatUsd(atomic)} but only USD ` +
          `${formatUsd(this.remainingAtomic)} of the USD ${formatUsd(this.capAtomic)} ` +
          `SPEND_CAP_USD is left (USD ${formatUsd(this.#spent)} spent across ` +
          `${this.#calls} charged lookup${this.#calls === 1 ? '' : 's'}` +
          (this.#reserved > 0n ? `, USD ${formatUsd(this.#reserved)} in flight` : '') +
          (outstanding > 0n
            ? `, USD ${formatUsd(outstanding)} in signed authorisations that were not charged ` +
              'and have not expired yet'
            : '') +
          '). Restart the server with a higher SPEND_CAP_USD to continue.',
      );
    }
    this.#reserved += atomic;

    let settled = false;
    const signatures: SignedAuthorisation[] = [];
    const ledger = this;

    /** Everything this lookup has authorised, whatever the response says about it. */
    function signedTotal(): bigint {
      let total = 0n;
      for (const signature of signatures) total += signature.atomic;
      return total;
    }

    function latestExpiry(): number {
      let latest = 0;
      for (const signature of signatures) {
        if (signature.expiresAtMs > latest) latest = signature.expiresAtMs;
      }
      return latest;
    }

    return {
      reservedAtomic: atomic,
      noteSignature(signature: SignedAuthorisation): void {
        signatures.push(signature);
      },
      commit(actualAtomic?: bigint): void {
        if (settled) return;
        settled = true;
        const reported = actualAtomic === undefined ? atomic : actualAtomic;
        const signed = signedTotal();
        // Upper bound: the reservation, which is the per-call ceiling the
        // operator approved. Lower bound: what was actually signed, so a payee
        // reporting `price_usd: 0` cannot buy an unbounded number of calls.
        const floor = reported > signed ? reported : signed;
        const charged = floor > atomic ? atomic : floor;
        ledger.#reserved -= atomic;
        ledger.#spent += charged;
        if (charged > 0n) ledger.#calls += 1;
        // Signed more than the cap allows charging for? The excess is still live.
        ledger.#hold(signed - charged, latestExpiry());
      },
      release(): void {
        if (settled) return;
        settled = true;
        ledger.#reserved -= atomic;
        ledger.#hold(signedTotal(), latestExpiry());
      },
      settleDefault(): void {
        if (settled) return;
        // A signature exists and nobody told us what became of it: charge it.
        // Over-reporting spend stops early, under-reporting spends the money.
        if (signatures.length > 0) this.commit();
        else this.release();
      },
    };
  }

  /** A one-line summary safe to put in a tool result. Contains no key material. */
  summary(): string {
    const outstanding = this.outstandingAtomic;
    return (
      `spent USD ${formatUsd(this.#spent)} of the USD ${formatUsd(this.capAtomic)} cap ` +
      `over ${this.#calls} charged lookup${this.#calls === 1 ? '' : 's'}; ` +
      (outstanding > 0n
        ? `USD ${formatUsd(outstanding)} in uncharged authorisations still live; `
        : '') +
      `USD ${formatUsd(this.remainingAtomic)} remaining`
    );
  }
}
