import type { Config } from './config.js';
import type { SpendLedger } from './ledger.js';
import { atomicFromRequirement, formatUsd, parseUsd } from './money.js';
import type { PaidFetch } from './payment.js';

export class LookupError extends Error {
  override name = 'LookupError';
  constructor(
    message: string,
    readonly charged: boolean | 'unknown' = false,
  ) {
    super(message);
  }
}

export interface LookupArgs {
  abn?: string | undefined;
  acn?: string | undefined;
  name?: string | undefined;
  limit?: number | undefined;
}

export interface Company {
  company_name: string;
  acn: string | null;
  arbn: string | null;
  abn: string | null;
  status: string | null;
  status_code: string | null;
  entity_type: string | null;
  entity_type_code: string | null;
  class: string | null;
  sub_class: string | null;
  date_of_registration: string | null;
  date_of_deregistration: string | null;
  previous_state_of_registration: string | null;
  state_registration_number: string | null;
  current_name_start_date: string | null;
  former_names: string[];
}

export interface LookupResult {
  found: boolean;
  charged: boolean;
  count: number;
  results: Company[];
  price_usd: number | null;
  settlement_tx: string | null;
  spend: string;
  note: string | null;
  attribution: string;
}

const ATTRIBUTION =
  'Contains ASIC Company Register data sourced from data.gov.au, ' +
  '© Australian Securities and Investments Commission, licensed under CC BY 3.0 AU. ' +
  'This is a weekly snapshot, not the official register; ASIC Connect is authoritative.';

/**
 * Validate the query before it can cost anything.
 *
 * The API charges nothing for a 400, but a refusal that never leaves the process
 * is faster and tells the agent exactly what to fix. Exactly one of abn, acn or
 * name, because two of them is ambiguous rather than a narrower search.
 */
export function buildQuery(args: LookupArgs): URLSearchParams {
  const abn = args.abn?.replace(/[\s-]/g, '');
  const acn = args.acn?.replace(/[\s-]/g, '');
  const name = args.name?.trim();

  const given = [
    abn ? 'abn' : null,
    acn ? 'acn' : null,
    name ? 'name' : null,
  ].filter((value): value is string => value !== null);

  if (given.length === 0) {
    throw new LookupError('give exactly one of abn, acn or name.');
  }
  if (given.length > 1) {
    throw new LookupError(
      `give exactly one of abn, acn or name; got ${given.join(' and ')}. ` +
        'They are alternative ways to identify one company, not filters that combine.',
    );
  }

  const params = new URLSearchParams();
  if (abn) {
    if (!/^\d{11}$/.test(abn)) {
      throw new LookupError(`an ABN is 11 digits; got ${abn.length} character(s).`);
    }
    params.set('abn', abn);
  } else if (acn) {
    if (!/^\d{9}$/.test(acn)) {
      throw new LookupError(`an ACN is 9 digits; got ${acn.length} character(s).`);
    }
    params.set('acn', acn);
  } else if (name) {
    if (name.length < 2) {
      throw new LookupError('a name search needs at least 2 characters.');
    }
    params.set('name', name);
  }

  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25) {
      throw new LookupError(`limit must be a whole number between 1 and 25; got ${args.limit}.`);
    }
    params.set('limit', String(args.limit));
  }

  return params;
}

function priceToAtomic(priceUsd: unknown): bigint | null {
  if (typeof priceUsd !== 'number' && typeof priceUsd !== 'string') return null;
  try {
    return parseUsd(priceUsd);
  } catch {
    return null;
  }
}

/**
 * One paid lookup, with the spend reconciled against what actually happened.
 *
 * The ledger reserves the per-call ceiling before the request, because that is
 * the most this call can cost and concurrent calls must not collectively overrun
 * the cap. Afterwards the reservation is settled against the truth: a 200 charges
 * the price the response reports, a 404 charges nothing because the API releases
 * the authorisation, and a 503 whose `charged` is `"unknown"` is counted in full
 * because money may have moved and pretending otherwise would understate spend.
 */
export async function lookupCompany(
  args: LookupArgs,
  deps: { config: Config; fetchWithPay: PaidFetch; ledger: SpendLedger },
): Promise<LookupResult> {
  const { config, fetchWithPay, ledger } = deps;
  const params = buildQuery(args);
  const url = `${config.apiBaseUrl}/v1/company?${params.toString()}`;

  const reservation = ledger.reserve(config.maxPricePerCallAtomic);

  let response: Response;
  try {
    response = await fetchWithPay(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    // Nothing was settled: either no signature was produced, or the request
    // never reached the resource server.
    reservation.release();
    throw error;
  }

  const bodyText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    // Fall through: the status still tells us how to settle.
  }

  const settlementTx =
    (body['payment'] as Record<string, unknown> | undefined)?.['settlement_tx'] ?? null;

  if (response.status === 200) {
    const payment = (body['payment'] as Record<string, unknown> | undefined) ?? {};
    const chargedAtomic = priceToAtomic(payment['price_usd']);
    reservation.commit(chargedAtomic ?? undefined);
    const results = Array.isArray(body['results']) ? (body['results'] as Company[]) : [];
    return {
      found: results.length > 0,
      charged: body['charged'] === true,
      count: typeof body['count'] === 'number' ? body['count'] : results.length,
      results,
      price_usd: typeof payment['price_usd'] === 'number' ? payment['price_usd'] : null,
      settlement_tx: typeof settlementTx === 'string' ? settlementTx : null,
      spend: ledger.summary(),
      note: null,
      attribution: ATTRIBUTION,
    };
  }

  if (response.status === 404) {
    // Documented as free: the query was valid and matched nothing, and the
    // payment authorisation is released rather than settled.
    reservation.release();
    return {
      found: false,
      charged: false,
      count: 0,
      results: [],
      price_usd: null,
      settlement_tx: null,
      spend: ledger.summary(),
      note: 'No company matched. A miss is free: you were not charged for this lookup.',
      attribution: ATTRIBUTION,
    };
  }

  if (response.status === 400 || response.status === 422) {
    reservation.release();
    throw new LookupError(
      `the API rejected the query before charging anything: ${detail(body, bodyText)}`,
    );
  }

  if (response.status === 402) {
    reservation.release();
    const asking = firstPrice(body);
    throw new LookupError(
      'the API still wants payment after a payment was presented, so nothing was charged. ' +
        (asking ? `It is asking USD ${asking}. ` : '') +
        'Check that the wallet holds USDC on Base mainnet.',
    );
  }

  if (response.status === 429) {
    reservation.release();
    const retryAfter = response.headers.get('retry-after');
    throw new LookupError(
      `rate limited by the API${retryAfter ? `; retry after ${retryAfter}s` : ''}. Nothing was charged.`,
    );
  }

  if (response.status === 409) {
    // The authorisation was already used. Counted as spent rather than released:
    // over-reporting spend stops early, under-reporting spends the user's money.
    reservation.commit();
    throw new LookupError(
      'this payment authorisation was already used or is still in flight, so the API refused it. ' +
        'Do not retry the identical request; run the lookup again to sign a fresh authorisation. ' +
        'The cap has been debited for it because the money may already have moved.',
      'unknown',
    );
  }

  if (response.status === 503) {
    const charged = body['charged'];
    if (charged === false) {
      reservation.release();
      throw new LookupError(
        'the payment could not be verified against the facilitator and no transfer was attempted, ' +
          'so nothing was charged. Safe to retry.',
        false,
      );
    }
    reservation.commit();
    throw new LookupError(
      'the payment was submitted to the facilitator and its outcome was never learnt, so USD ' +
        `${formatUsd(config.maxPricePerCallAtomic)} MAY have left the wallet. It has been debited ` +
        'against the cap. Do not sign a fresh payment for this query; retrying the identical ' +
        'lookup would be a second charge.',
      'unknown',
    );
  }

  reservation.release();
  throw new LookupError(
    `unexpected ${response.status} from the API: ${detail(body, bodyText)}. Nothing was charged.`,
  );
}

function detail(body: Record<string, unknown>, bodyText: string): string {
  const detailValue = body['detail'] ?? body['error'];
  if (typeof detailValue === 'string') return detailValue;
  if (detailValue !== undefined) return JSON.stringify(detailValue);
  return bodyText.slice(0, 300) || '(no body)';
}

function firstPrice(body: Record<string, unknown>): string | null {
  const accepts = body['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const atomic = atomicFromRequirement(accepts[0] as Record<string, unknown>);
  return atomic === null ? null : formatUsd(atomic);
}
