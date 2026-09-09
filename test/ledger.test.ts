import { describe, expect, it } from 'vitest';
import { SpendCapExceeded, SpendLedger } from '../src/ledger.js';

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

  it('gives the reservation back when nothing was charged', () => {
    const ledger = new SpendLedger(1_000_000n);
    ledger.reserve(10_000n).release();
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.chargedCallCount).toBe(0);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('never commits more than was reserved, even if the API reports a bigger price', () => {
    const ledger = new SpendLedger(1_000_000n);
    ledger.reserve(10_000n).commit(999_999n);
    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('ignores a second settle on the same reservation', () => {
    const ledger = new SpendLedger(1_000_000n);
    const reservation = ledger.reserve(10_000n);
    reservation.commit();
    reservation.commit();
    reservation.release();
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
