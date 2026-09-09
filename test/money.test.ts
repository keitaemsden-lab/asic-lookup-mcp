import { describe, expect, it } from 'vitest';
import { atomicFromRequirement, formatUsd, MoneyFormatError, parseUsd, toSpendControlMoney } from '../src/money.js';

describe('parseUsd', () => {
  it('parses plain and dollar-prefixed decimals to atomic USDC units', () => {
    expect(parseUsd('0.01')).toBe(10_000n);
    expect(parseUsd('$0.01')).toBe(10_000n);
    expect(parseUsd('1')).toBe(1_000_000n);
    expect(parseUsd(' 2.50 ')).toBe(2_500_000n);
    expect(parseUsd('0.000001')).toBe(1n);
  });

  it('does not drift the way a float multiply would', () => {
    // 0.29 * 1e6 is 289999.99999999994 in IEEE 754.
    expect(parseUsd('0.29')).toBe(290_000n);
    expect(parseUsd('1.005')).toBe(1_005_000n);
  });

  it('refuses anything that is not a plain decimal amount', () => {
    for (const bad of ['', 'abc', '1e6', '-1', '1.2.3', 'NaN', '0x10']) {
      expect(() => parseUsd(bad), bad).toThrow(MoneyFormatError);
    }
  });

  it('refuses precision USDC cannot represent rather than truncating a cap', () => {
    expect(() => parseUsd('0.0000001')).toThrow(/more than 6 decimal places/);
  });
});

describe('formatUsd', () => {
  it('renders at least two decimal places', () => {
    expect(formatUsd(10_000n)).toBe('0.01');
    expect(formatUsd(1_000_000n)).toBe('1.00');
    expect(formatUsd(0n)).toBe('0.00');
    expect(formatUsd(1n)).toBe('0.000001');
  });

  it('round-trips through parseUsd', () => {
    for (const atomic of [1n, 10_000n, 999_999n, 1_000_000n, 123_456_789n]) {
      expect(parseUsd(formatUsd(atomic))).toBe(atomic);
    }
  });
});

describe('atomicFromRequirement', () => {
  it('reads the v2 amount field and the v1 maxAmountRequired field', () => {
    expect(atomicFromRequirement({ amount: '10000' }, 2)).toBe(10_000n);
    expect(atomicFromRequirement({ maxAmountRequired: '10000' }, 1)).toBe(10_000n);
  });

  it('resolves a document carrying both fields the way the signer does', () => {
    // @x402/core signs `maxAmountRequired` on v1 and `amount` on v2. Reading
    // them in a fixed order means screening one number and signing another --
    // survivable today only because zod happens to strip unknown keys off the
    // v1 schema, which is a dependency's accident, not a defence.
    const both = { amount: '10000', maxAmountRequired: '99999' };
    expect(atomicFromRequirement(both, 2)).toBe(10_000n);
    expect(atomicFromRequirement(both, 1)).toBe(99_999n);
  });

  it('falls back to the other spelling when a document carries only one', () => {
    expect(atomicFromRequirement({ amount: '10000' }, 1)).toBe(10_000n);
    expect(atomicFromRequirement({ maxAmountRequired: '10000' }, 2)).toBe(10_000n);
  });

  it('returns null for anything that is not an integer atomic amount', () => {
    expect(atomicFromRequirement({ amount: '$0.01' })).toBeNull();
    expect(atomicFromRequirement({ amount: '1.5' })).toBeNull();
    expect(atomicFromRequirement({})).toBeNull();
  });
});

describe('toSpendControlMoney', () => {
  it('produces the dollar-string form the x402 client expects', () => {
    expect(toSpendControlMoney(10_000n)).toBe('$0.01');
    expect(toSpendControlMoney(5_000_000n)).toBe('$5.00');
  });
});
