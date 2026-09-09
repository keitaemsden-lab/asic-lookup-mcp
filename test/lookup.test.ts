import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SpendCapExceeded, SpendLedger } from '../src/ledger.js';
import { buildQuery, LookupError, lookupCompany } from '../src/lookup.js';

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

describe('lookupCompany accounting', () => {
  it('charges the price the response reports, once', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(200, {
      query: { name: 'woolworths' },
      count: 1,
      charged: true,
      results: [COMPANY],
      payment: { price_usd: 0.01, settlement_tx: '0xabc', network: 'base' },
    });

    const result = await lookupCompany(
      { name: 'woolworths', limit: 5 },
      { config: config(), fetchWithPay: api.fetch, ledger },
    );

    expect(result.found).toBe(true);
    expect(result.charged).toBe(true);
    expect(result.count).toBe(1);
    expect(result.settlement_tx).toBe('0xabc');
    expect(ledger.spentAtomic).toBe(10_000n);
    expect(ledger.reservedAtomic).toBe(0n);
    expect(api.urls[0]).toBe('https://api.example.test/v1/company?name=woolworths&limit=5');
  });

  it('charges nothing for a miss, and says so', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(404, { charged: false, count: 0, results: [] });

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
  });

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

  it('releases the reservation on a rate limit and surfaces Retry-After', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const api = respond(429, { detail: 'slow down' }, { 'retry-after': '30' });

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: api.fetch, ledger }),
    ).rejects.toThrow(/retry after 30s/);

    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.remainingAtomic).toBe(1_000_000n);
  });

  it('releases the reservation when the request never completes', async () => {
    const ledger = new SpendLedger(1_000_000n);
    const failing = (async () => {
      throw new Error('socket hang up');
    }) as never;

    await expect(
      lookupCompany({ name: 'woolworths' }, { config: config(), fetchWithPay: failing, ledger }),
    ).rejects.toThrow(/socket hang up/);

    expect(ledger.reservedAtomic).toBe(0n);
    expect(ledger.spentAtomic).toBe(0n);
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
});
