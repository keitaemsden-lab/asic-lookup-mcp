import { describe, expect, it } from 'vitest';
import { SpendCapExceeded, SpendLedger } from '../src/ledger.js';

/** A clock a test can wind forward, so an authorisation can be watched to expire. */
function fakeClock(start = 1_757_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceSeconds(seconds: number) {
      now += seconds * 1000;
    },
  };
}

/** One signed authorisation for `atomic`, live for `seconds`. */
function signature(atomic: bigint, seconds: number, clock = { now: () => Date.now() }) {
  return { atomic, expiresAtMs: clock.now() + seconds * 1000 };
}

describe('SpendLedger', () => {
  it('reserves against the cap and commits the actual charge', () => {
    const ledger = new SpendLedger(1_000_000n); // USD 1.00
    const reservation = ledger.reserve(10_000n);
    expect(ledger.reservedAtomic).toBe(10_000n);
    expect(ledger.remainingAtomic).toBe(990_000n);

    reservation.commit(10_000n);
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.chargedCallCount).toBe(1);
  });

  it('gives the reservation back when nothing was signed and nothing was charged', () => {
    const ledger = new SpendLedger(1_000_000n);
    ledger.reserve(10_000n).release();
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.outstandingAtomic).toBe(0n);
    expect(ledger.chargedCallCount).toBe(0);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('never commits more than was reserved, and never less than was signed', () => {
    const overReported = new SpendLedger(1_000_000n);
    overReported.reserve(10_000n).commit(999_999n);
    expect(overReported.spentAtomic).toBe(10_000n);

    // The dangerous direction, and the one B2 exploited: the payee reports a
    // price of zero for a payment it holds a USD 0.01 signature for. The report
    // is a claim; the signature is the money.
    const underReported = new SpendLedger(1_000_000n);
    const reservation = underReported.reserve(10_000n);
    reservation.noteSignature(signature(10_000n, 300));
    reservation.commit(0n);
    expect(underReported.spentAtomic).toBe(10_000n);
    expect(underReported.chargedCallCount).toBe(1);
  });

  it('stops a payee that reports price zero from buying an unbounded run of calls', () => {
    // Verbatim from the review's proof: 500 lookups at a reported price of 0,
    // each signing USD 0.01, against a USD 1.00 cap.
    const ledger = new SpendLedger(1_000_000n);
    let admitted = 0;
    for (let index = 0; index < 500; index += 1) {
      let reservation;
      try {
        reservation = ledger.reserve(10_000n);
      } catch (error) {
        expect(error).toBeInstanceOf(SpendCapExceeded);
        break;
      }
      admitted += 1;
      reservation.noteSignature(signature(10_000n, 300));
      reservation.commit(0n);
    }
    expect(admitted).toBe(100); // USD 1.00 / USD 0.01, not 500
    expect(ledger.spentAtomic).toBe(1_000_000n);
  });

  it('holds a signed-then-released authorisation against the cap until it expires', () => {
    // The headline finding: a 404 is free, but the authorisation it signed is
    // still in the payee's hands and still settleable. "Released" is a promise,
    // not a revocation.
    const clock = fakeClock();
    const ledger = new SpendLedger(1_000_000n, clock.now);
    const reservation = ledger.reserve(10_000n);
    reservation.noteSignature(signature(10_000n, 300, clock));
    reservation.release();

    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.outstandingAtomic).toBe(10_000n);
    expect(ledger.remainingAtomic).toBe(990_000n);

    clock.advanceSeconds(299);
    expect(ledger.outstandingAtomic).toBe(10_000n);

    // Past validBefore the signature cannot be settled by anyone, so the cap
    // gets it back. This is the only thing that gives it back.
    clock.advanceSeconds(2);
    expect(ledger.outstandingAtomic).toBe(0n);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('stops a run of free misses from handing out more authorisations than the cap', () => {
    // The review's other proof: 10,000 misses against a USD 1.00 cap used to be
    // USD 100 of live authorisations, invisible to the ledger.
    const clock = fakeClock();
    const ledger = new SpendLedger(1_000_000n, clock.now);
    let misses = 0;
    for (let index = 0; index < 10_000; index += 1) {
      let reservation;
      try {
        reservation = ledger.reserve(10_000n);
      } catch (error) {
        expect(error).toBeInstanceOf(SpendCapExceeded);
        break;
      }
      misses += 1;
      reservation.noteSignature(signature(10_000n, 300, clock));
      reservation.release(); // the 404 path
    }
    expect(misses).toBe(100);
    expect(ledger.outstandingAtomic).toBe(1_000_000n);
    expect(ledger.spentAtomic).toBe(0n);

    // And it is a hold, not a permanent burn: once the authorisations expire the
    // budget comes back.
    clock.advanceSeconds(301);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('names the outstanding exposure when it refuses, rather than claiming nothing was spent', () => {
    const clock = fakeClock();
    const ledger = new SpendLedger(10_000n, clock.now);
    const reservation = ledger.reserve(10_000n);
    reservation.noteSignature(signature(10_000n, 300, clock));
    reservation.release();

    expect(() => ledger.reserve(10_000n)).toThrow(/signed authorisations that were not charged/);
    expect(ledger.summary()).toMatch(/USD 0.01 in uncharged authorisations still live/);
  });

  it('charges by default when a settle path is skipped after a signature exists', () => {
    const ledger = new SpendLedger(1_000_000n);
    const reservation = ledger.reserve(10_000n);
    reservation.noteSignature(signature(10_000n, 300));
    reservation.settleDefault();
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
  });

  it('releases by default when a settle path is skipped and nothing was signed', () => {
    const ledger = new SpendLedger(1_000_000n);
    const reservation = ledger.reserve(10_000n);
    reservation.settleDefault();
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('ignores a second settle on the same reservation', () => {
    const ledger = new SpendLedger(1_000_000n);
    const reservation = ledger.reserve(10_000n);
    reservation.commit();
    reservation.commit();
    reservation.release();
    reservation.settleDefault();
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
  });

  it('counts concurrent in-flight lookups so they cannot collectively overrun the cap', () => {
    const ledger = new SpendLedger(20_000n); // room for exactly two lookups
    ledger.reserve(10_000n);
    ledger.reserve(10_000n);
    expect(() => ledger.reserve(10_000n)).toThrow(SpendCapExceeded);
  });

  it('lets a released reservation be spent by the next lookup', () => {
    const ledger = new SpendLedger(10_000n);
    const first = ledger.reserve(10_000n);
    expect(() => ledger.reserve(10_000n)).toThrow(SpendCapExceeded);
    first.release();
    expect(() => ledger.reserve(10_000n)).not.toThrow();
  });

  it('stops once the cap is spent, and says how much went where', () => {
    const ledger = new SpendLedger(20_000n);
    ledger.reserve(10_000n).commit();
    ledger.reserve(10_000n).commit();
    expect(() => ledger.reserve(10_000n)).toThrow(
      /only USD 0.00 of the USD 0.02 SPEND_CAP_USD is left/,
    );
    expect(ledger.summary()).toBe(
      'spent USD 0.02 of the USD 0.02 cap over 2 charged lookups; USD 0.00 remaining',
    );
  });

  it('refuses a nonsensical cap or reservation', () => {
    expect(() => new SpendLedger(0n)).toThrow(RangeError);
    expect(() => new SpendLedger(10_000n).reserve(0n)).toThrow(RangeError);
  });
});
