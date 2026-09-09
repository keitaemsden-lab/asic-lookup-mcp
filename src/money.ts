/**
 * Money is handled in atomic USDC units (integers, 6 decimals) everywhere except
 * at the edges where a human reads or writes it.
 *
 * Doing spend caps in floating point is how you get a cap of 0.30 that lets
 * 0.30000000000000004 through, so nothing here multiplies a float by 1e6.
 */

/** USDC on Base has 6 decimals. */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export class MoneyFormatError extends Error {}

/**
 * Parse a human decimal USD string into atomic USDC units.
 *
 * Accepts `1`, `1.5`, `0.01`, `$0.01`, ` 0.010000 `. Rejects anything with more
 * than six decimal places rather than silently truncating a cap the caller
 * meant literally.
 */
export function parseUsd(input: string | number): bigint {
  const raw = String(input).trim().replace(/^\$/, '').replace(/_/g, '');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new MoneyFormatError(
      `not a plain decimal USD amount: ${JSON.stringify(String(input))}. Use e.g. 0.50 or $0.50.`,
    );
  }
  const [whole, fraction = ''] = raw.split('.') as [string, string?];
  if (fraction.length > USDC_DECIMALS) {
    throw new MoneyFormatError(
      `${raw} has more than ${USDC_DECIMALS} decimal places, which USDC cannot represent.`,
    );
  }
  const padded = fraction.padEnd(USDC_DECIMALS, '0');
  return BigInt(whole) * SCALE + BigInt(padded);
}

/** Format atomic USDC units as a plain decimal string, trailing zeros trimmed to 2dp minimum. */
export function formatUsd(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(USDC_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${trimmed}`;
}

/**
 * Read the amount a requirement will actually be signed for.
 *
 * The two wire versions disagree about which field is authoritative, and
 * `@x402/core` resolves it by version: v1 signs `maxAmountRequired`, v2 signs
 * `amount`. Reading them in the other order means screening one number and
 * signing another, so the version is required rather than assumed. Both are
 * integer atomic units of `asset`; anything else returns null rather than a
 * guess, because a number we cannot read is not one we will sign against.
 *
 * @param requirement - one `accepts` entry, as it came off the wire
 * @param x402Version - the version of the document the entry came from
 * @returns the atomic amount, or null if the entry does not state one readably
 */
export function atomicFromRequirement(
  requirement: Record<string, unknown>,
  x402Version = 2,
): bigint | null {
  const raw =
    x402Version === 1
      ? requirement['maxAmountRequired'] ?? requirement['amount']
      : requirement['amount'] ?? requirement['maxAmountRequired'];
  return atomicFromValue(raw);
}

/** Parse an integer atomic-unit field, or null if it is not one. */
export function atomicFromValue(raw: unknown): bigint | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/** The `$0.01` string form the x402 client's own spend controls expect. */
export function toSpendControlMoney(atomic: bigint): string {
  return `$${formatUsd(atomic)}`;
}
