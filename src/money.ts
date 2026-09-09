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
 * Read an amount off an x402 payment requirement.
 *
 * v1 calls it `maxAmountRequired`, v2 calls it `amount`, and both are integer
 * atomic units of `asset`. An amount that is not an integer string is not
 * something we will sign against, so this returns null rather than guessing.
 */
export function atomicFromRequirement(requirement: Record<string, unknown>): bigint | null {
  const raw = requirement['amount'] ?? requirement['maxAmountRequired'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/** The `$0.01` string form the x402 client's own spend controls expect. */
export function toSpendControlMoney(atomic: bigint): string {
  return `$${formatUsd(atomic)}`;
}
