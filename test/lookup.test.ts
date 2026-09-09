import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RetryLatch } from '../src/latch.js';
import { SpendCapExceeded, SpendLedger } from '../src/ledger.js';
import { buildQuery, LookupError, lookupCompany, normaliseCompany } from '../src/lookup.js';
import { createPaidFetch } from '../src/payment.js';
import challenge from './fixtures/challenge-402.json' with { type: 'json' };

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function config(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    PRIVATE_KEY: TEST_KEY,
    SPEND_CAP_USD: '1.00',
    API_BASE_URL: 'https://api.example.test',
    ...env,
  });
}

const COMPANY = {
  company_name: 'WOOLWORTHS GROUP LIMITED',
  acn: '000014675',
  arbn: null,
  abn: '88000014675',
  status: 'Registered',
  status_code: 'REGD',
  entity_type: 'Australian public company',
  entity_type_code: 'APUB',
  class: 'Limited by shares',
  sub_class: 'Listed public company',
  date_of_registration: '1924-09-22',
  date_of_deregistration: null,
  previous_state_of_registration: 'NSW',
  state_registration_number: '00921434',
  current_name_start_date: null,
  former_names: ['WOOLWORTHS LTD'],
};

/** A fetch that answers with one canned response and records the url it was given. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as never;
  return { fetch: fetchImpl, urls };
}

/**
 * A fetch that really pays.
 *
 * The stub answers the first attempt with the 402 the live API serves and the
 * second with whatever this lookup is meant to see, and the fetch in between is
 * the real `createPaidFetch` -- so an authorisation is genuinely signed and the
 * ledger is genuinely told about it. Accounting tests that stub the payment
 * away cannot tell "nothing was charged" from "nothing was signed", which is
 * the exact distinction every finding here turns on.
 *
 * @param answer - what the paid attempt gets: a Response, or a thrown error
 */
function payingApi(
  answer: () => Response | Promise<Response>,
  env: NodeJS.ProcessEnv = {},
  delayPerAttemptMs = 0,
) {
  const attempts: { paid: boolean }[] = [];
  const header = Buffer.from(JSON.stringify(challenge.v2Document)).toString('base64');

  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as never, init as never);
    const paid = Boolean(
      request.headers.get('PAYMENT-SIGNATURE') ?? request.headers.get('X-PAYMENT'),
    );
    attempts.push({ paid });
    if (delayPerAttemptMs > 0) {
      // Honours the abort signal, the way a real fetch does. A stub that ignores
      // it cannot tell a per-attempt deadline from a shared one.
      // The signal can arrive on init or on the Request itself, depending on
      // how the payment wrapper calls through. A real fetch honours both.
      const signal = init?.signal ?? request.signal;
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        const timer = setTimeout(resolve, delayPerAttemptMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }
    if (!paid) {
      return new Response(JSON.stringify(challenge.v1Body), {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': header },
      });
    }
    return answer();
  }) as unknown as typeof globalThis.fetch;

  return { fetch: createPaidFetch(config(env), base), attempts };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const PAID_OK = {
  query: { name: 'woolworths' },
  count: 1,
  charged: true,
  results: [COMPANY],
  payment: { price_usd: 0.01, settlement_tx: '0xabc', network: 'base' },
};

describe('buildQuery', () => {
  it('needs exactly one identifier', () => {
    expect(() => buildQuery({})).toThrow(/exactly one of abn, acn or name/);
    expect(() => buildQuery({ abn: '51824753556', name: 'csiro' })).toThrow(/got abn and name/);
    expect(() => buildQuery({ abn: '51824753556', acn: '000014675', name: 'x' })).toThrow(
      /abn and acn and name/,
    );
  });

  it('strips the spaces and hyphens people paste an ABN with', () => {
    expect(buildQuery({ abn: '51 824 753 556' }).get('abn')).toBe('51824753556');
    expect(buildQuery({ acn: '000-014-675' }).get('acn')).toBe('000014675');
  });

  it('checks identifier length before anything can cost money', () => {
    expect(() => buildQuery({ abn: '123' })).toThrow(/an ABN is 11 digits/);
    expect(() => buildQuery({ acn: '1234567890' })).toThrow(/an ACN is 9 digits/);
    expect(() => buildQuery({ abn: '5182475355X' })).toThrow(/an ABN is 11 digits/);
    expect(() => buildQuery({ name: 'a' })).toThrow(/at least 2 characters/);
  });

  it('bounds the limit the API bounds', () => {
    expect(buildQuery({ name: 'woolworths', limit: 5 }).get('limit')).toBe('5');
    expect(buildQuery({ name: 'woolworths' }).has('limit')).toBe(false);
    for (const limit of [0, 26, 1.5, -1]) {
      expect(() => buildQuery({ name: 'woolworths', limit }), String(limit)).toThrow(
        /between 1 and 25/,
      );
    }
  });
});

describe('lookupCompany accounting, against a fetch that really signs', () => {
  it('charges the price the response reports when the payee reports it honestly', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() => json(200, PAID_OK));

    const result = await lookupCompany(
      { name: 'woolworths', limit: 5 },
      { config: config(), fetchWithPay: api.fetch, ledger },
    );

    expect(result.found).toBe(true);
    expect(result.charged).toBe(true);
    expect(result.settlement_tx).toBe('0xabc');
    expect(api.attempts).toEqual([{ paid: false }, { paid: true }]);
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.chargedCallCount).toBe(1);
  });

  it('debits what was signed, not the price the payee chose to report', async () => {
    // The payee reports a price of zero for a lookup it holds a USD 0.01
    // signature for. Trusting the report is what let 500 signed payments run
    // against a USD 1.00 cap with `spent = 0` and a clean summary line.
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() =>
      json(200, { ...PAID_OK, payment: { price_usd: 0, settlement_tx: '0xabc' } }),
    );

    await lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger });

    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.chargedCallCount).toBe(1);
  });

  it('lets a payee report a higher price than it signed for, but not charge it', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() =>
      json(200, { ...PAID_OK, payment: { price_usd: 500, settlement_tx: '0xabc' } }),
    );

    await lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger });

    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('charges nothing for a miss but keeps the authorisation it signed against the cap', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() => json(404, { charged: false, count: 0, results: [] }));

    const result = await lookupCompany(
      { name: 'zzzznotacompany' },
      { config: config(), fetchWithPay: api.fetch, ledger },
    );

    expect(result.found).toBe(false);
    expect(result.charged).toBe(false);
    expect(result.note).toMatch(/A miss is free/);
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.chargedCallCount).toBe(0);
    // The payee holds a live USD 0.01 authorisation for this "free" miss.
    expect(ledger.outstandingAtomic).toBe(10_000n);
    expect(result.spend).toMatch(/uncharged authorisations still live/);
  });

  it('stops a run of free misses at the cap instead of handing out authorisations forever', async () => {
    // Ten thousand misses against a USD 1.00 cap used to be USD 100 of live
    // authorisations. The cap has to bound signatures, not settlements.
    const ledger = new SpendLedger(100_000n); // USD 0.10: ten lookups
    const api = payingApi(() => json(404, { charged: false, count: 0, results: [] }));
    let misses = 0;

    for (let index = 0; index < 50; index += 1) {
      try {
        await lookupCompany(
          { name: `miss${index}` },
          { config: config(), fetchWithPay: api.fetch, ledger },
        );
        misses += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(SpendCapExceeded);
        break;
      }
    }

    expect(misses).toBe(10);
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.outstandingAtomic).toBe(100_000n);
  });

  it('charges, and does not release, when the request throws after the payment was sent', async () => {
    // A timeout between sending the paid request and reading its response. The
    // signature is in the payee's hands, the facilitator may already have
    // settled it, and neither of the old comment's disjuncts holds.
    const ledger = new SpendLedger(1_000_000n);
    const latch = new RetryLatch();
    const api = payingApi(() => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    });

    const error = await lookupCompany(
      { name: 'woolworths' },
      { config: config(), fetchWithPay: api.fetch, ledger, latch },
    ).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(LookupError);
    expect((error as LookupError).charged).toBe('unknown');
    expect((error as Error).message).toMatch(/MAY have left the wallet/);
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
  });

  it('releases the reservation when it throws before any signature exists', async () => {
    // The other half of the same branch, and the reason the old test could not
    // fail: its stub threw before a 402 was ever served, so it only ever
    // exercised this case while claiming to cover both.
    const ledger = new SpendLedger(1_000_000n);
    const failing = (async () => {
      throw new Error('socket hang up');
    }) as never;

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: failing, ledger }),
    ).rejects.toThrow(/socket hang up/);

    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.outstandingAtomic).toBe(0n);
  });

  it('settles the reservation when the body stream fails after the headers arrived', async () => {
    // `response.text()` is a live stream: a truncated or terminated body throws
    // here, outside every branch that settles. A hundred of these used to leave
    // the whole cap reserved and every later lookup refused by a message
    // insisting nothing had been spent.
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow();

    expect(ledger.reservedAtomic).toBe(0n);
    // A signature went out and nobody told us what became of it: charged.
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.remainingAtomic).toBe(990_000n);
  });

  it('tells the caller a dropped body may have cost money, and latches the query', async () => {
    // The path B3's try/finally created. It settled correctly and said nothing:
    // `Lookup failed. terminated`, no `charged: unknown`, no latch -- so a model
    // in a loop burned the cap a cent at a time while being told nothing moved.
    // That is the B4 defect wearing a different hat.
    const ledger = new SpendLedger(1_000_000n);
    const latch = new RetryLatch();
    const api = payingApi(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const deps = { config: config(), fetchWithPay: api.fetch, ledger, latch };

    const error = await lookupCompany({ name: 'woolworths' }, deps).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(LookupError);
    expect((error as LookupError).charged).toBe('unknown');
    expect((error as Error).message).toMatch(/MAY have left the wallet/);
    expect((error as Error).message).toMatch(/while reading the response body/);
    expect(ledger.spentAtomic).toBe(10_000n);

    // And the retry is refused rather than signing a second authorisation.
    const signaturesSoFar = api.attempts.filter((attempt) => attempt.paid).length;
    await expect(lookupCompany({ name: 'woolworths' }, deps)).rejects.toThrow(
      /authorisation it signed is still live/,
    );
    expect(api.attempts.filter((attempt) => attempt.paid)).toHaveLength(signaturesSoFar);
    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('keeps taking lookups after a hundred failed body reads', async () => {
    const ledger = new SpendLedger(100_000_000n); // USD 100
    const api = payingApi(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    for (let index = 0; index < 100; index += 1) {
      await lookupCompany(
        { name: `query${index}` },
        { config: config(), fetchWithPay: api.fetch, ledger },
      ).catch(() => undefined);
    }

    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.spentAtomic).toBe(1_000_000n); // 100 x USD 0.01, honestly counted
    expect(() => ledger.reserve(10_000n)).not.toThrow();
  });

  it('gives the paid retry its own deadline instead of the leftovers of 402 discovery', async () => {
    // One AbortSignal.timeout used to cover 402 discovery AND the paid retry, so
    // the budget for the request that carries the money was whatever discovery
    // left over -- and a timeout in that state is the worst outcome there is:
    // the signature is gone and the outcome is unknown. Two attempts at 700ms
    // each, against a 1000ms per-attempt deadline: fine per attempt, fatal
    // shared.
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() => json(200, PAID_OK), { REQUEST_TIMEOUT_MS: '1000' }, 700);

    const result = await lookupCompany(
      { name: 'woolworths' },
      { config: config({ REQUEST_TIMEOUT_MS: '1000' }), fetchWithPay: api.fetch, ledger },
    );

    expect(result.found).toBe(true);
    expect(api.attempts).toEqual([{ paid: false }, { paid: true }]);
    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('tells the caller it was charged when a 200 returns no records', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = payingApi(() =>
      json(200, {
        count: 0,
        charged: true,
        results: [],
        payment: { price_usd: 0.01, settlement_tx: '0xabc' },
      }),
    );

    const result = await lookupCompany(
      { name: 'woolworths' },
      { config: config(), fetchWithPay: api.fetch, ledger },
    );

    expect(result.found).toBe(false);
    expect(result.charged).toBe(true);
    expect(result.note).toMatch(/reported the lookup as charged/);
    expect(ledger.spentAtomic).toBe(10_000n);
  });
});

describe('lookupCompany outcomes', () => {
  it('debits the cap when the payment outcome is unknown, because money may have moved', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(503, { charged: 'unknown' });

    await expect(
      lookupCompany({ abn: '51824753556' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/outcome was never learnt/);

    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
  });

  it('does not debit the cap when the facilitator verifiably did not transfer', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(503, { charged: false });

    await expect(
      lookupCompany({ abn: '51824753556' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/Safe to retry/);

    expect(ledger.spentAtomic).toBe(0n);
  });

  it('debits the cap for a reused authorisation, erring towards over-reporting spend', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(409, { detail: 'authorisation already in flight' });

    await expect(
      lookupCompany({ abn: '51824753556' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/already used or is still in flight/);

    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('refuses the identical query after an unknown outcome, rather than advising against it', () => {
    // "Do not retry" is prose, and the caller is a model in a loop. This is the
    // control: the query is held until the authorisation it signed expires.
    const ledger = new SpendLedger(1_000_000n);
    const latch = new RetryLatch();
    const api = respond(503, { charged: 'unknown' });
    const deps = { config: config(), fetchWithPay: api.fetch, ledger, latch };

    return lookupCompany({ abn: '51824753556' }, deps)
      .catch(() => undefined)
      .then(async () => {
        await expect(lookupCompany({ abn: '51824753556' }, deps)).rejects.toThrow(
          /authorisation it signed is still live/,
        );
        // The second attempt was refused before it became a request or a
        // reservation, so it cost nothing.
        expect(api.urls).toHaveLength(1);
        expect(ledger.spentAtomic).toBe(10_000n);
        // A different query is unaffected.
        await expect(lookupCompany({ abn: '51824753557' }, deps)).rejects.toThrow(
          /outcome was never learnt/,
        );
      });
  });

  it('latches on the lookup, not on the query string that spelled it', async () => {
    // The API matches names case-insensitively and `limit` does not change the
    // price, so these are one lookup wearing four query strings. Latching on
    // `params.toString()` let a caller sign a fresh authorisation for each.
    const ledger = new SpendLedger(1_000_000n);
    const latch = new RetryLatch();
    const api = respond(503, { charged: 'unknown' });
    const deps = { config: config(), fetchWithPay: api.fetch, ledger, latch };

    await expect(lookupCompany({ name: 'woolworths' }, deps)).rejects.toThrow(/never learnt/);
    expect(api.urls).toHaveLength(1);

    for (const args of [
      { name: 'woolworths' },
      { name: 'Woolworths' },
      { name: 'WOOLWORTHS' },
      { name: ' woolworths ' },
      { name: 'woolworths', limit: 5 },
    ]) {
      await expect(lookupCompany(args, deps), JSON.stringify(args)).rejects.toThrow(
        /authorisation it signed is still live/,
      );
    }
    // Not one of them became a request, so not one signed anything.
    expect(api.urls).toHaveLength(1);
    expect(ledger.spentAtomic).toBe(10_000n);

    // A genuinely different company is unaffected.
    await expect(lookupCompany({ name: 'coles' }, deps)).rejects.toThrow(/never learnt/);
    expect(api.urls).toHaveLength(2);
  });

  it('releases the reservation on a rate limit and surfaces Retry-After in both forms', async () => {
    const seconds = respond(429, { detail: 'slow down' }, { 'retry-after': '30' });
    await expect(
      lookupCompany(
        { name: 'woolworths' },
        { config: config(), fetchWithPay: seconds.fetch, ledger: new SpendLedger(1_000_000n) },
      ),
    ).rejects.toThrow(/retry after 30s/);

    // The HTTP-date form is equally legal, and "Wed, 09 Sep 2026 06:00:00 GMTs"
    // is not a duration.
    const httpDate = respond(
      429,
      { detail: 'slow down' },
      { 'retry-after': 'Wed, 09 Sep 2026 06:00:00 GMT' },
    );
    const error = await lookupCompany(
      { name: 'woolworths' },
      { config: config(), fetchWithPay: httpDate.fetch, ledger: new SpendLedger(1_000_000n) },
    ).then(() => null, (reason: unknown) => reason);
    expect((error as Error).message).toMatch(/retry after Wed, 09 Sep 2026 06:00:00 GMT\./);
  });

  it('releases the reservation on a 402 that survived payment', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(402, { accepts: [{ amount: '10000' }] });

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/still wants payment/);

    expect(ledger.spentAtomic).toBe(0n);
  });

  it('stops paying once the cap is reached rather than sending the request', async () => {
    const ledger = new SpendLedger(10_000n); // exactly one lookup
    const api = respond(200, {
      count: 1,
      charged: true,
      results: [COMPANY],
      payment: { price_usd: 0.01, settlement_tx: '0x1', network: 'base' },
    });

    await lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger });
    await expect(
      lookupCompany({ name: 'coles' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(SpendCapExceeded);

    // The second lookup never became a request.
    expect(api.urls).toHaveLength(1);
  });

  it('rejects a bad query without spending or sending anything', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(200, {});

    await expect(
      lookupCompany({}, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(LookupError);

    expect(api.urls).toHaveLength(0);
    expect(ledger.reservedAtomic).toBe(0n);
  });

  it('survives a response that is not JSON', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(502, '<html>bad gateway</html>');

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/unexpected 502/);

    expect(ledger.spentAtomic).toBe(0n);
  });

  it('asks the API the query it was given', async () => {
    const api = respond(200, PAID_OK);
    await lookupCompany(
      { name: 'woolworths', limit: 5 },
      { config: config(), fetchWithPay: api.fetch, ledger: new SpendLedger(1_000_000n) },
    );
    expect(api.urls[0]).toBe('https://api.example.test/v1/company?name=woolworths&limit=5');
  });
});

describe('normaliseCompany', () => {
  it('coerces the fields the API can drift on into the shape the schema declares', () => {
    const drifted = normaliseCompany({ ...COMPANY, former_names: null, status: undefined });
    expect(drifted.former_names).toEqual([]);
    expect(drifted.status).toBeNull();
    expect(drifted.company_name).toBe('WOOLWORTHS GROUP LIMITED');
  });

  it('keeps fields the schema does not declare rather than dropping paid data', () => {
    const extended = normaliseCompany({ ...COMPANY, gst_status: 'Registered' });
    expect((extended as unknown as Record<string, unknown>)['gst_status']).toBe('Registered');
  });

  it('leaves a well-formed record untouched', () => {
    expect(normaliseCompany(COMPANY)).toEqual(COMPANY);
  });

  it('coerces a former name rather than dropping it', () => {
    // Dropping a former name because it arrived in an unexpected shape is the
    // same loss the SDK's discard was, just quieter -- and it is a field the
    // caller has already paid for.
    expect(normaliseCompany({ ...COMPANY, former_names: 'OLD PTY LTD' }).former_names).toEqual([
      'OLD PTY LTD',
    ]);
    expect(
      normaliseCompany({ ...COMPANY, former_names: [{ name: 'OLD PTY LTD' }] }).former_names,
    ).toEqual(['OLD PTY LTD']);
    expect(
      normaliseCompany({ ...COMPANY, former_names: ['A', { name: 'B' }, 'C'] }).former_names,
    ).toEqual(['A', 'B', 'C']);
    const opaque = normaliseCompany({ ...COMPANY, former_names: [{ was: 'X' }] }).former_names;
    expect(opaque).toHaveLength(1);
    expect(opaque[0]).toContain('X');
  });
});
