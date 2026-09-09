import { AsyncLocalStorage } from 'node:async_hooks';
import { ExactEvmScheme } from '@x402/evm';
import { ExactEvmSchemeV1 } from '@x402/evm/exact/v1/client';
import { wrapFetchWithPayment, x402Client, type PaymentPolicy } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_NETWORKS, USDC_BASE, type Config } from './config.js';
import type { SignedAuthorisation } from './ledger.js';
import { atomicFromRequirement, atomicFromValue, formatUsd, toSpendControlMoney } from './money.js';

export type PaidFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

export class PaymentRefused extends Error {
  override name = 'PaymentRefused';
}

/** The subset of an x402 payment requirement this server inspects. */
type Requirement = Record<string, unknown>;

/** What `screenRequirement` checks a 402 against. */
export interface ScreeningPolicy {
  maxPricePerCallAtomic: bigint;
  /** The only payee a signature may name. */
  expectedPayTo: string;
  /** Ceiling on `maxTimeoutSeconds`, i.e. on how long the signature stays spendable. */
  maxAuthorisationSeconds: number;
}

/** Asset transfer methods whose signature shape this project has audited. */
const AUDITED_TRANSFER_METHODS = new Set(['eip3009']);

/**
 * Decide whether one `accepts` entry is something we will sign, and say why not
 * if it is not.
 *
 * Every clause here is a way a hostile or misconfigured endpoint could obtain a
 * signature it should not have: a different chain, a different token, a
 * different payee, a payment scheme whose semantics we have not audited, a
 * price above the ceiling the user approved, or a lifetime long enough that
 * "released" stops meaning anything. The x402 client would happily sign the
 * server's asking price, because to the library any `amount` in a 402 is just
 * the price. The number that actually leaves the wallet is the one inside the
 * signed authorisation, so it is checked here, against the demand, not against
 * what we expected the demand to be.
 *
 * @param requirement - one `accepts` entry, as it came off the wire
 * @param policy - the ceilings and the pinned payee
 * @param x402Version - which wire version this entry came from; it decides which price field signs
 */
export function screenRequirement(
  requirement: Requirement,
  policy: ScreeningPolicy,
  x402Version = 2,
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
  if (payTo.toLowerCase() !== policy.expectedPayTo.toLowerCase()) {
    return {
      ok: false,
      reason:
        `payTo ${payTo} is not the payee this server pays (${policy.expectedPayTo}). ` +
        'If the endpoint legitimately moved, set EXPECTED_PAY_TO to the new address',
    };
  }

  // `extra` steers which signature the scheme produces. `assetTransferMethod:
  // "permit2"` routes to a PermitWitnessTransferFrom to the x402 proxy, and
  // `paymentFlow` moves the whole thing onto the escrow flow -- shapes this
  // project has not audited, and which a wallet that has ever approved Permit2
  // for USDC would honour.
  const extra = requirement['extra'];
  if (extra !== undefined && extra !== null) {
    if (typeof extra !== 'object' || Array.isArray(extra)) {
      return { ok: false, reason: `extra ${JSON.stringify(extra)} is not an object` };
    }
    const fields = extra as Record<string, unknown>;
    const transferMethod = fields['assetTransferMethod'];
    if (transferMethod !== undefined && !AUDITED_TRANSFER_METHODS.has(String(transferMethod))) {
      return {
        ok: false,
        reason:
          `extra.assetTransferMethod ${JSON.stringify(transferMethod)} would sign something other ` +
          'than an EIP-3009 transfer, which this server has not audited',
      };
    }
    if (fields['paymentFlow'] !== undefined) {
      return {
        ok: false,
        reason:
          `extra.paymentFlow ${JSON.stringify(fields['paymentFlow'])} moves the payment off the ` +
          'plain transfer this server audits',
      };
    }
  }

  // How long the signature stays spendable. `@x402/evm` turns this into the
  // authorisation's `validBefore`, so an unscreened value is a signature the
  // payee can hold and settle long after the lookup it paid for is forgotten.
  const timeout = requirement['maxTimeoutSeconds'];
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return {
        ok: false,
        reason: `maxTimeoutSeconds ${JSON.stringify(timeout)} is not a positive number of seconds`,
      };
    }
    if (timeout > policy.maxAuthorisationSeconds) {
      return {
        ok: false,
        reason:
          `the endpoint wants an authorisation valid for ${timeout} seconds, and this server signs ` +
          `nothing that stays spendable for more than ${policy.maxAuthorisationSeconds} ` +
          '(MAX_AUTHORISATION_SECONDS)',
      };
    }
  }

  const atomic = atomicFromRequirement(requirement, x402Version);
  if (atomic === null) {
    return {
      ok: false,
      reason: `price ${JSON.stringify(requirement['amount'] ?? requirement['maxAmountRequired'])} is not an integer atomic amount`,
    };
  }
  if (atomic <= 0n) {
    return { ok: false, reason: 'price is zero, which is not a payment' };
  }
  if (atomic > policy.maxPricePerCallAtomic) {
    return {
      ok: false,
      reason:
        `the endpoint is asking USD ${formatUsd(atomic)} for this call but MAX_PRICE_USD_PER_CALL ` +
        `is USD ${formatUsd(policy.maxPricePerCallAtomic)}. Raise MAX_PRICE_USD_PER_CALL only if you ` +
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
export function buildPolicy(policy: ScreeningPolicy): PaymentPolicy {
  return (x402Version, requirements) => {
    const kept: typeof requirements = [];
    const reasons: string[] = [];
    for (const requirement of requirements) {
      const verdict = screenRequirement(
        requirement as unknown as Requirement,
        policy,
        x402Version,
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

/** Told about every authorisation this process signs, the moment it is signed. */
export interface SignatureObserver {
  onSigned(signature: SignedAuthorisation): void;
}

/**
 * The observer for the lookup currently on this async stack.
 *
 * The paying fetch is built once and shared by every concurrent tool call, but
 * a signature belongs to exactly one of them. `AsyncLocalStorage` is what makes
 * that attribution correct without threading a token through a library API that
 * has nowhere to put one.
 */
const currentObserver = new AsyncLocalStorage<SignatureObserver>();

/** Run `body`, telling `observer` about any authorisation signed while it runs. */
export function observingSignatures<T>(observer: SignatureObserver, body: () => Promise<T>): Promise<T> {
  return currentObserver.run(observer, body);
}

/**
 * Read what a created payload actually authorises.
 *
 * The payload is the ground truth: the value in the signature is the number
 * that can leave the wallet, whatever the requirement said and whatever the
 * response will later claim. Falls back to the screened requirement only when
 * the payload shape is one we do not recognise, so an unknown shape is counted
 * at its full ceiling rather than as free.
 *
 * @param payload - the `paymentPayload` from `onAfterPaymentCreation`
 * @param fallbackAtomic - what to assume was signed if the payload cannot be read
 * @param fallbackSeconds - lifetime to assume if the payload states none
 */
export function describeSignature(
  payload: { accepted?: Record<string, unknown>; payload?: Record<string, unknown>; x402Version?: number },
  fallbackAtomic: bigint,
  fallbackSeconds: number,
  nowMs: number = Date.now(),
): SignedAuthorisation {
  const inner = (payload.payload ?? {}) as Record<string, unknown>;
  const eip3009 = inner['authorization'] as Record<string, unknown> | undefined;
  const permit2 = inner['permit2Authorization'] as Record<string, unknown> | undefined;

  let atomic: bigint | null = null;
  let validBeforeSeconds: bigint | null = null;

  if (eip3009) {
    atomic = atomicFromValue(eip3009['value']);
    validBeforeSeconds = atomicFromValue(eip3009['validBefore']);
  } else if (permit2) {
    const permitted = permit2['permitted'] as Record<string, unknown> | undefined;
    atomic = atomicFromValue(permitted?.['amount']);
    validBeforeSeconds = atomicFromValue(permit2['deadline']);
  }

  const requirement = payload.accepted ?? {};
  const declared = atomicFromRequirement(requirement, payload.x402Version ?? 2);
  const expiresAtMs =
    validBeforeSeconds === null
      ? nowMs + fallbackSeconds * 1000
      : Number(validBeforeSeconds) * 1000;

  return {
    atomic: atomic ?? declared ?? fallbackAtomic,
    expiresAtMs,
  };
}

/**
 * Give every network attempt its own deadline.
 *
 * One `AbortSignal.timeout` on the outer call is shared by the unpaid 402
 * discovery AND the paid retry, so the budget for the request that carries the
 * money is whatever the discovery left over. A timeout in that state is the
 * worst case there is: the signature is gone and the outcome is unknown.
 */
function perAttemptDeadline(baseFetch: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    // `wrapFetchWithPayment` calls its fetch with a Request and no init, so a
    // caller's abort rides on the Request rather than on init. Composing with
    // both means the per-attempt deadline shortens a caller's deadline and
    // never silently replaces it.
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const attempt = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, attempt]) : attempt;
    return baseFetch(input, { ...(init ?? {}), signal });
  }) as typeof globalThis.fetch;
}

/**
 * Build a `fetch` that pays 402s from the configured wallet, and refuses anything
 * outside the audited envelope.
 *
 * Four independent limits sit in front of the signing key:
 *   1. only the `eip155:8453` / `base` scheme clients are registered, so a 402
 *      naming any other chain has nothing to sign it;
 *   2. the library's own spend controls cap a single payment in USD;
 *   3. `buildPolicy` re-checks scheme, network, asset, payee, `extra`,
 *      authorisation lifetime and price against the user's ceiling before a
 *      signature exists;
 *   4. every signature that does get created is reported to the ledger through
 *      `onAfterPaymentCreation`, before the paid request is sent.
 *
 * The cumulative cap is not here. It belongs to the SpendLedger, which knows
 * about lookups rather than about payments.
 *
 * `new ExactEvmScheme(signer)` is deliberately built with no scheme options.
 * With RPC options the scheme's gas-sponsoring hook will sign
 * `approve(Permit2, MAX_UINT256)` -- an unlimited USDC allowance -- whenever a
 * server advertises `eip2612GasSponsoring`. Do not pass them.
 */
export function createPaidFetch(config: Config, baseFetch: typeof globalThis.fetch = fetch): PaidFetch {
  const signer = privateKeyToAccount(config.privateKey);
  const policy: ScreeningPolicy = {
    maxPricePerCallAtomic: config.maxPricePerCallAtomic,
    expectedPayTo: config.expectedPayTo,
    maxAuthorisationSeconds: config.maxAuthorisationSeconds,
  };

  // The API answers a 402 with a v2 document in the PAYMENT-REQUIRED header AND a
  // v1 document in the body. v2 wins when both are present; v1 is registered as
  // well so an older deployment of the API still works.
  //
  // The v1 slot takes ExactEvmSchemeV1, not ExactEvmScheme. They are not
  // interchangeable: the v2 class derives the chain id from a CAIP-2 network and
  // throws "Unsupported network format: base" on every v1 document, so the v1
  // fallback registered with the v2 class could never sign anything.
  const client = new x402Client()
    .register('eip155:8453', new ExactEvmScheme(signer))
    .registerV1('base', new ExactEvmSchemeV1(signer))
    .setSpendControls({ maxAmountPerPayment: toSpendControlMoney(config.maxPricePerCallAtomic) })
    .registerPolicy(buildPolicy(policy))
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      currentObserver.getStore()?.onSigned(
        describeSignature(
          paymentPayload as never,
          config.maxPricePerCallAtomic,
          config.maxAuthorisationSeconds,
        ),
      );
    });

  return wrapFetchWithPayment(perAttemptDeadline(baseFetch, config.requestTimeoutMs), client);
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
