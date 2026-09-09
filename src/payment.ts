import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, x402Client, type PaymentPolicy } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_NETWORKS, USDC_BASE, type Config } from './config.js';
import { atomicFromRequirement, formatUsd, toSpendControlMoney } from './money.js';

export type PaidFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

export class PaymentRefused extends Error {
  override name = 'PaymentRefused';
}

/** The subset of an x402 payment requirement this server inspects. */
type Requirement = Record<string, unknown>;

/**
 * Decide whether one `accepts` entry is something we will sign, and say why not
 * if it is not.
 *
 * Every clause here is a way a hostile or misconfigured endpoint could obtain a
 * signature it should not have: a different chain, a different token, a payment
 * scheme whose semantics we have not audited, or simply a price above the
 * ceiling the user approved. The x402 client would happily sign the server's
 * asking price, because to the library any `amount` in a 402 is just the price.
 * The number that actually leaves the wallet is the one inside the signed
 * authorisation, so it is checked here, against the demand, not against what we
 * expected the demand to be.
 */
export function screenRequirement(
  requirement: Requirement,
  maxPricePerCallAtomic: bigint,
): { ok: true; atomic: bigint } | { ok: false; reason: string } {
  const scheme = requirement['scheme'];
  if (scheme !== 'exact') {
    return { ok: false, reason: `scheme ${JSON.stringify(scheme)} is not "exact"` };
  }

  const network = String(requirement['network'] ?? '').toLowerCase();
  if (!BASE_NETWORKS.has(network)) {
    return { ok: false, reason: `network ${JSON.stringify(requirement['network'])} is not Base mainnet` };
  }

  const asset = String(requirement['asset'] ?? '');
  if (asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    return { ok: false, reason: `asset ${JSON.stringify(asset)} is not USDC on Base (${USDC_BASE})` };
  }

  const payTo = String(requirement['payTo'] ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    return { ok: false, reason: `payTo ${JSON.stringify(payTo)} is not an address` };
  }

  const atomic = atomicFromRequirement(requirement);
  if (atomic === null) {
    return {
      ok: false,
      reason: `price ${JSON.stringify(requirement['amount'] ?? requirement['maxAmountRequired'])} is not an integer atomic amount`,
    };
  }
  if (atomic <= 0n) {
    return { ok: false, reason: 'price is zero, which is not a payment' };
  }
  if (atomic > maxPricePerCallAtomic) {
    return {
      ok: false,
      reason:
        `the endpoint is asking USD ${formatUsd(atomic)} for this call but MAX_PRICE_USD_PER_CALL ` +
        `is USD ${formatUsd(maxPricePerCallAtomic)}. Raise MAX_PRICE_USD_PER_CALL only if you ` +
        'accept the new price',
    };
  }

  return { ok: true, atomic };
}

/**
 * The x402 client policy: keep only the `accepts` entries we are willing to sign,
 * and throw a message that names the actual problem rather than letting the
 * library report a generic "all requirements were filtered out".
 */
export function buildPolicy(maxPricePerCallAtomic: bigint): PaymentPolicy {
  return (_x402Version, requirements) => {
    const kept: typeof requirements = [];
    const reasons: string[] = [];
    for (const requirement of requirements) {
      const verdict = screenRequirement(
        requirement as unknown as Requirement,
        maxPricePerCallAtomic,
      );
      if (verdict.ok) kept.push(requirement);
      else reasons.push(verdict.reason);
    }
    if (kept.length === 0) {
      throw new PaymentRefused(
        `refused to pay for this lookup: ${reasons.join('; ') || 'the 402 offered no payment options at all'}.`,
      );
    }
    return kept;
  };
}

/**
 * Build a `fetch` that pays 402s from the configured wallet, and refuses anything
 * outside the audited envelope.
 *
 * Three independent limits sit in front of the signing key:
 *   1. only the `eip155:8453` / `base` scheme clients are registered, so a 402
 *      naming any other chain has nothing to sign it;
 *   2. the library's own spend controls cap a single payment in USD;
 *   3. `buildPolicy` re-checks scheme, network, asset, payee and price against
 *      the user's ceiling before a signature exists.
 *
 * The cumulative cap is not here. It belongs to the SpendLedger, which knows
 * about lookups rather than about payments.
 */
export function createPaidFetch(config: Config, baseFetch: typeof globalThis.fetch = fetch): PaidFetch {
  const signer = privateKeyToAccount(config.privateKey);

  // The API answers a 402 with a v2 document in the PAYMENT-REQUIRED header AND a
  // v1 document in the body. v2 wins when both are present; v1 is registered as
  // well so an older deployment of the API still works.
  const client = new x402Client()
    .register('eip155:8453', new ExactEvmScheme(signer))
    .registerV1('base', new ExactEvmScheme(signer))
    .setSpendControls({ maxAmountPerPayment: toSpendControlMoney(config.maxPricePerCallAtomic) })
    .registerPolicy(buildPolicy(config.maxPricePerCallAtomic));

  return wrapFetchWithPayment(baseFetch, client);
}

/**
 * Turn a payment failure into one sentence naming the setting the operator can change.
 *
 * Two independent gates can refuse a price, and only one of them is ours. The
 * x402 client applies its own spend controls before any policy runs, so a price
 * above the ceiling is usually rejected by the library first, in a message that
 * names `maxAmountPerPayment` -- a field of an object the operator never sees.
 * Both gates are kept, because the library's USD cap silently does not apply to
 * an asset its default-asset table does not recognise and `screenRequirement` has
 * no such hole. This translates whichever one fired.
 *
 * @param error - anything thrown out of the paying fetch
 * @returns a replacement message, or null if this is not a payment refusal
 */
export function explainPaymentError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof PaymentRefused || message.includes('refused to pay for this lookup')) {
    return message.slice(message.indexOf('refused to pay'));
  }
  if (message.includes('spendControls.maxAmountPerPayment')) {
    const asking = /\(\$([\d.]+)/.exec(message)?.[1];
    return (
      'refused to pay for this lookup: the endpoint asked for more than the per-call ceiling of ' +
      `USD ${asking ?? 'the configured amount'}. Raise MAX_PRICE_USD_PER_CALL only if you accept ` +
      'the new price.'
    );
  }
  if (message.includes('rejected by spendControls')) {
    return (
      'refused to pay for this lookup: the endpoint asked for payment in a token this server will ' +
      'not sign for. It pays only USDC on Base mainnet.'
    );
  }
  if (message.includes('No network/scheme registered')) {
    return (
      'refused to pay for this lookup: the endpoint asked for payment on a network this server ' +
      'will not sign for. It pays only on Base mainnet.'
    );
  }
  return null;
}

/** The address that will pay, for the startup banner. Derived, never the key itself. */
export function payerAddress(config: Config): string {
  return privateKeyToAccount(config.privateKey).address;
}
