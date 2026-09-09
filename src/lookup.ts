import type { Config } from './config.js';
import type { SignedAuthorisation, SpendLedger } from './ledger.js';
import type { RetryLatch } from './latch.js';
import { atomicFromRequirement, formatUsd, parseUsd } from './money.js';
import { observingSignatures, type PaidFetch } from './payment.js';

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

/** A field the API declares as a nullable string, coerced to one or to null. */
function nullableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Coerce one register record into the shape the tool's own output schema declares.
 *
 * The record has already been paid for. The MCP SDK validates
 * `structuredContent` against `outputSchema` and, on a mismatch, discards the
 * entire result -- so one `former_names: null` from the API turns a charged
 * lookup into an error with no data, and the model's obvious next move is to
 * pay for it again. Anything unrecognised is passed through untouched: the
 * schema allows extra keys, and dropping data the caller paid for is the one
 * outcome worse than a surprising field.
 */
export function normaliseCompany(record: unknown): Company {
  const raw = (typeof record === 'object' && record !== null ? record : {}) as Record<string, unknown>;
  const formerNames = Array.isArray(raw['former_names'])
    ? raw['former_names'].filter((name): name is string => typeof name === 'string')
    : [];
  return {
    ...raw,
    company_name: typeof raw['company_name'] === 'string' ? raw['company_name'] : '(name not returned)',
    acn: nullableString(raw['acn']),
    arbn: nullableString(raw['arbn']),
    abn: nullableString(raw['abn']),
    status: nullableString(raw['status']),
    status_code: nullableString(raw['status_code']),
    entity_type: nullableString(raw['entity_type']),
    entity_type_code: nullableString(raw['entity_type_code']),
    class: nullableString(raw['class']),
    sub_class: nullableString(raw['sub_class']),
    date_of_registration: nullableString(raw['date_of_registration']),
    date_of_deregistration: nullableString(raw['date_of_deregistration']),
    previous_state_of_registration: nullableString(raw['previous_state_of_registration']),
    state_registration_number: nullableString(raw['state_registration_number']),
    current_name_start_date: nullableString(raw['current_name_start_date']),
    former_names: formerNames,
  } as Company;
}

/** How a `Retry-After` header should be read back to the caller. */
function describeRetryAfter(value: string | null): string {
  if (!value) return '';
  // Either a number of seconds or an HTTP-date. Appending "s" to a date is wrong.
  return /^\d+$/.test(value.trim()) ? `; retry after ${value.trim()}s` : `; retry after ${value}`;
}

/**
 * One paid lookup, with the spend reconciled against what was signed.
 *
 * The ledger reserves the per-call ceiling before the request, because that is
 * the most this call can cost and concurrent calls must not collectively overrun
 * the cap. Afterwards the reservation is settled against the truth, and the
 * truth is the signature rather than the response: a 200 charges at least what
 * was signed, a 404 gives the reservation back but keeps the signed amount held
 * as live exposure until it expires, and anything that ends after a signature
 * exists is charged rather than released, because a signature in someone else's
 * hands is not a refund.
 */
export async function lookupCompany(
  args: LookupArgs,
  deps: { config: Config; fetchWithPay: PaidFetch; ledger: SpendLedger; latch?: RetryLatch },
): Promise<LookupResult> {
  const { config, fetchWithPay, ledger, latch } = deps;
  const params = buildQuery(args);
  const query = params.toString();
  const url = `${config.apiBaseUrl}/v1/company?${query}`;

  const heldMs = latch?.heldMs(query) ?? null;
  if (heldMs !== null) {
    throw new LookupError(
      `this exact query already produced a payment whose outcome was never learnt, and the ` +
        `authorisation it signed is still live. Repeating it would sign a second one. Try again in ` +
        `${Math.ceil(heldMs / 1000)}s, or change the query.`,
      'unknown',
    );
  }

  const reservation = ledger.reserve(config.maxPricePerCallAtomic);
  const signatures: SignedAuthorisation[] = [];
  const observer = {
    onSigned(signature: SignedAuthorisation): void {
      signatures.push(signature);
      reservation.noteSignature(signature);
    },
  };

  /** Hold the query against a retry for as long as the signature stays spendable. */
  function latchQuery(): void {
    latch?.hold(query, config.maxAuthorisationSeconds * 1000);
  }

  let response: Response;
  try {
    response = await observingSignatures(observer, () =>
      fetchWithPay(url, { headers: { Accept: 'application/json' } }),
    );
  } catch (error) {
    if (signatures.length > 0) {
      // A signed authorisation went to the payee before this threw. Whether the
      // request reached the resource server or the facilitator settled it is
      // exactly what we do not know, and the payee has a valid signature either
      // way. Releasing here is how a timeout became free money for the payee.
      reservation.commit();
      latchQuery();
      const reason = error instanceof Error ? error.message : String(error);
      throw new LookupError(
        `the request failed after a payment authorisation had already been signed and sent, so USD ` +
          `${formatUsd(config.maxPricePerCallAtomic)} MAY have left the wallet. It has been debited ` +
          `against the cap, and this query is held against a retry until the authorisation expires. ` +
          `The failure was: ${reason}`,
        'unknown',
      );
    }
    // No signature was ever created, so nothing can settle.
    reservation.release();
    throw error;
  }

  // Everything past this point can throw -- including `response.text()` itself,
  // which is a live stream and fails on a truncated or aborted body. A throw
  // that escapes without settling leaks the reservation for the life of the
  // process, and after enough of them every later lookup is refused by a cap
  // message insisting nothing was spent.
  try {
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
      // The reported price is a floor, not a fact: `commit` never debits less
      // than was signed, so a payee reporting 0 cannot buy free calls.
      reservation.commit(chargedAtomic ?? undefined);
      const results = (Array.isArray(body['results']) ? body['results'] : []).map(normaliseCompany);
      return {
        found: results.length > 0,
        charged: body['charged'] === true,
        count: typeof body['count'] === 'number' ? body['count'] : results.length,
        results,
        price_usd: typeof payment['price_usd'] === 'number' ? payment['price_usd'] : null,
        settlement_tx: typeof settlementTx === 'string' ? settlementTx : null,
        spend: ledger.summary(),
        note:
          results.length === 0
            ? 'The API returned no records for this query but reported the lookup as charged.'
            : null,
        attribution: ATTRIBUTION,
      };
    }

    if (response.status === 404) {
      // Documented as free: the query was valid and matched nothing, and the API
      // does not settle the authorisation. It cannot un-sign it either, so the
      // ledger keeps the signed amount as outstanding exposure until it expires.
      reservation.release();
      return {
        found: false,
        charged: false,
        count: 0,
        results: [],
        price_usd: null,
        settlement_tx: null,
        spend: ledger.summary(),
        note:
          'No company matched. A miss is free: you were not charged for this lookup. The payment ' +
          'authorisation it signed stays valid until it expires, so it is still counted against ' +
          'the cap until then.',
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
      throw new LookupError(
        `rate limited by the API${describeRetryAfter(response.headers.get('retry-after'))}. ` +
          'Nothing was settled.',
      );
    }

    if (response.status === 409) {
      // The authorisation was already used. Counted as spent rather than released:
      // over-reporting spend stops early, under-reporting spends the user's money.
      reservation.commit();
      latchQuery();
      throw new LookupError(
        'this payment authorisation was already used or is still in flight, so the API refused it. ' +
          'The cap has been debited for it because the money may already have moved, and this ' +
          'query is held against a retry until the authorisation expires.',
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
      latchQuery();
      throw new LookupError(
        'the payment was submitted to the facilitator and its outcome was never learnt, so USD ' +
          `${formatUsd(config.maxPricePerCallAtomic)} MAY have left the wallet. It has been debited ` +
          'against the cap, and this query is held against a retry until the authorisation expires.',
        'unknown',
      );
    }

    reservation.release();
    throw new LookupError(
      `unexpected ${response.status} from the API: ${detail(body, bodyText)}. Nothing was settled.`,
    );
  } finally {
    // No-op when one of the branches above already settled. When none did --
    // a body that never arrived, or anything else thrown on the way -- this
    // charges if a signature exists and releases if none does.
    reservation.settleDefault();
  }
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
