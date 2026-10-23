import { describe, expect, it } from 'vitest';
import { RetryLatch } from '../src/latch.js';

/** A clock a test can wind forward, or back, to watch a hold expire. */
function fakeClock(start = 1_757_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceMs(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

describe('RetryLatch', () => {
  it('reports null for a key that was never held', () => {
    const latch = new RetryLatch(fakeClock().now);
    expect(latch.heldMs('k')).toBeNull();
  });

  it('counts a hold down as the clock advances', () => {
    const clock = fakeClock();
    const latch = new RetryLatch(clock.now);
    latch.hold('k', 5000);
    expect(latch.heldMs('k')).toBe(5000);
    clock.advanceMs(2000);
    expect(latch.heldMs('k')).toBe(3000);
  });

  it('releases a hold at exactly its expiry, and not a millisecond before', () => {
    const clock = fakeClock();
    const latch = new RetryLatch(clock.now);
    latch.hold('k', 5000);
    clock.advanceMs(4999);
    expect(latch.heldMs('k')).toBe(1);
    clock.advanceMs(1);
    expect(latch.heldMs('k')).toBeNull();
    // The entry is gone, so it stays null rather than going negative.
    expect(latch.heldMs('k')).toBeNull();
    clock.advanceMs(1000);
    expect(latch.heldMs('k')).toBeNull();
  });

  it('keeps the longer hold when a shorter one is asked for', () => {
    const clock = fakeClock();
    const latch = new RetryLatch(clock.now);
    latch.hold('k', 10_000);
    latch.hold('k', 1000);
    expect(latch.heldMs('k')).toBe(10_000);
  });

  it('extends a hold when a later one runs longer', () => {
    const clock = fakeClock();
    const latch = new RetryLatch(clock.now);
    latch.hold('k', 10_000);
    clock.advanceMs(1000);
    expect(latch.heldMs('k')).toBe(9000);
    latch.hold('k', 20_000);
    expect(latch.heldMs('k')).toBe(20_000);
  });

  it('holds each key independently', () => {
    const clock = fakeClock();
    const latch = new RetryLatch(clock.now);
    latch.hold('a', 1000);
    latch.hold('b', 5000);
    expect(latch.heldMs('a')).toBe(1000);
    expect(latch.heldMs('b')).toBe(5000);
    expect(latch.heldMs('c')).toBeNull();
    clock.advanceMs(1000);
    expect(latch.heldMs('a')).toBeNull();
    expect(latch.heldMs('b')).toBe(4000);
  });

  it('sweeps expired holds on other keys when a new hold is taken', () => {
    const clock = fakeClock();
    const start = clock.now();
    const latch = new RetryLatch(clock.now);
    latch.hold('a', 1000);
    clock.advanceMs(2000);
    latch.hold('b', 5000); // 'a' expired 1000ms ago and is never asked about
    // Wind back to before 'a' expired: an entry left unswept would reappear.
    clock.set(start + 500);
    expect(latch.heldMs('a')).toBeNull();
  });
});
