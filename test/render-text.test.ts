import { describe, expect, it } from 'vitest';
import type { Company, LookupResult } from '../src/lookup.js';
import { toToolResult } from '../src/server.js';

/**
 * The text half of a tool result is what a model actually reads, so its lines
 * are a contract: the count, which number identifies each company, and whether
 * (and for how much) the wallet was charged. Every record here is synthetic.
 */

function company(overrides: Partial<Company> = {}): Company {
  return {
    company_name: 'EXAMPLE WIDGETS PTY LTD',
    acn: '111111111',
    arbn: '222222222',
    abn: '33333333333',
    status: 'Registered',
    status_code: 'REGD',
    entity_type: 'Australian proprietary company',
    entity_type_code: 'APTY',
    class: null,
    sub_class: null,
    date_of_registration: null,
    date_of_deregistration: null,
    previous_state_of_registration: null,
    state_registration_number: null,
    current_name_start_date: null,
    former_names: [],
    ...overrides,
  };
}

function result(overrides: Partial<LookupResult> = {}): LookupResult {
  const results = overrides.results ?? [company()];
  return {
    found: true,
    charged: true,
    count: results.length,
    results,
    price_usd: 0.02,
    settlement_tx: null,
    spend: 'spent USD 0.02 of the USD 1.00 cap over 1 charged lookup; USD 0.98 remaining',
    note: null,
    attribution: 'Synthetic attribution line.',
    ...overrides,
  };
}

function text(r: LookupResult): string {
  return toToolResult(r).content[0]!.text;
}

/** The rendered line for the one company in a single-result lookup. */
function companyLine(c: Company): string {
  return text(result({ results: [c] })).split('\n')[1]!;
}

describe('toToolResult text: match count', () => {
  it('says "1 match:" for a single result', () => {
    expect(text(result()).split('\n')[0]).toBe('1 match:');
  });

  it('says "N matches:" for more than one result', () => {
    const r = result({
      results: [
        company({ company_name: 'ALPHA SYNTHETIC PTY LTD' }),
        company({ company_name: 'BETA SYNTHETIC PTY LTD' }),
        company({ company_name: 'GAMMA SYNTHETIC PTY LTD' }),
      ],
    });
    const lines = text(r).split('\n');
    expect(lines[0]).toBe('3 matches:');
    expect(lines.slice(1, 4)).toEqual([
      expect.stringContaining('ALPHA SYNTHETIC PTY LTD'),
      expect.stringContaining('BETA SYNTHETIC PTY LTD'),
      expect.stringContaining('GAMMA SYNTHETIC PTY LTD'),
    ]);
  });

  it('pluralises from count, not from the number of rendered rows', () => {
    expect(text(result({ count: 2, results: [company()] })).split('\n')[0]).toBe('2 matches:');
  });
});

describe('toToolResult text: identifier fallback', () => {
  it('prefers the ACN when ACN, ARBN and ABN are all present', () => {
    const line = companyLine(company());
    expect(line).toBe(
      '  EXAMPLE WIDGETS PTY LTD  |  111111111  |  Registered  |  Australian proprietary company',
    );
    expect(line).not.toContain('222222222');
    expect(line).not.toContain('33333333333');
  });

  it('falls back to the ARBN when there is no ACN', () => {
    const line = companyLine(company({ acn: null }));
    expect(line).toContain('  |  222222222  |  ');
    expect(line).not.toContain('33333333333');
  });

  it('falls back to the ABN when there is neither ACN nor ARBN', () => {
    expect(companyLine(company({ acn: null, arbn: null }))).toContain('  |  33333333333  |  ');
  });

  it('says "(no number)" when the record carries no identifier at all', () => {
    expect(companyLine(company({ acn: null, arbn: null, abn: null }))).toBe(
      '  EXAMPLE WIDGETS PTY LTD  |  (no number)  |  Registered  |  Australian proprietary company',
    );
  });
});

describe('toToolResult text: registered date', () => {
  it('appends "registered <date>" when the record has one', () => {
    expect(companyLine(company({ date_of_registration: '2001-02-03' }))).toBe(
      '  EXAMPLE WIDGETS PTY LTD  |  111111111  |  Registered  |  Australian proprietary company' +
        '  |  registered 2001-02-03',
    );
  });

  it('omits the registered segment entirely when there is no date', () => {
    const line = companyLine(company({ date_of_registration: null }));
    expect(line).not.toContain('registered');
    expect(line.endsWith('  |  ')).toBe(false);
  });
});

describe('toToolResult text: cost line', () => {
  it('states the charged price and the spend summary', () => {
    const lines = text(result({ price_usd: 0.02 })).split('\n');
    expect(lines).toContain(
      'Charged USD 0.02. spent USD 0.02 of the USD 1.00 cap over 1 charged lookup; USD 0.98 remaining.',
    );
  });

  it('defaults the price to 0.01 when the API did not report one', () => {
    expect(text(result({ price_usd: null }))).toContain('Charged USD 0.01. spent USD');
  });

  it('appends the settlement transaction when there is one', () => {
    expect(text(result({ settlement_tx: '0xfeedface' }))).toContain(
      'Charged USD 0.02 (tx 0xfeedface). spent USD',
    );
  });

  it('carries no transaction suffix when there is no settlement', () => {
    const t = text(result({ settlement_tx: null }));
    expect(t).toContain('Charged USD 0.02. spent USD');
    expect(t).not.toContain('(tx ');
  });

  it('says "Not charged." on an uncharged result, with no price or tx', () => {
    const t = text(result({ charged: false, settlement_tx: '0xfeedface' }));
    expect(t).toContain(
      'Not charged. spent USD 0.02 of the USD 1.00 cap over 1 charged lookup; USD 0.98 remaining.',
    );
    expect(t).not.toContain('Charged USD');
    expect(t).not.toContain('(tx ');
  });

  it('says "Not charged." on an uncharged miss', () => {
    const t = text(result({ found: false, charged: false, count: 0, results: [], note: 'Nothing matched.' }));
    expect(t).toBe(
      'No match. Nothing matched.\n\n' +
        'Not charged. spent USD 0.02 of the USD 1.00 cap over 1 charged lookup; USD 0.98 remaining.',
    );
  });

  it('keeps the cost line on a charged miss, default price and tx suffix included', () => {
    const t = text(
      result({ found: false, count: 0, results: [], price_usd: null, settlement_tx: '0xbeef' }),
    );
    expect(t).toContain('Charged USD 0.01 (tx 0xbeef). spent USD');
    expect(t).not.toContain('Not charged');
  });
});
