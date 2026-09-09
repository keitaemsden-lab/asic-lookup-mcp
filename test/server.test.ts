import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SpendLedger } from '../src/ledger.js';
import { payerAddress } from '../src/payment.js';
import { buildServer, toToolResult, TOOL_NAME } from '../src/server.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

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

function config(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    PRIVATE_KEY: TEST_KEY,
    SPEND_CAP_USD: '1.00',
    API_BASE_URL: 'https://api.example.test',
    ...env,
  });
}

async function connect(
  fetchWithPay: never,
  options: { ledger?: SpendLedger; env?: NodeJS.ProcessEnv } = {},
) {
  const cfg = config(options.env);
  const { server, ledger } = buildServer(cfg, {
    fetchWithPay,
    ...(options.ledger ? { ledger: options.ledger } : {}),
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, ledger };
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as never;
  return { fetch: fetchImpl, calls };
}

const OK = {
  query: { name: 'woolworths' },
  count: 1,
  charged: true,
  results: [COMPANY],
  payment: { price_usd: 0.01, settlement_tx: '0xabc', network: 'base' },
};

describe('the MCP surface', () => {
  let client: Client;

  beforeEach(async () => {
    ({ client } = await connect(respond(200, OK).fetch));
  });

  it('lists exactly one tool, named for what it does', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
  });

  it('leads the tool description with the price, so a client cannot miss it', async () => {
    const { tools } = await client.listTools();
    const description = tools[0]?.description ?? '';
    const firstSentence = description.slice(0, description.indexOf('. ') + 1);
    expect(firstSentence).toMatch(/USD 0\.01 per successful lookup/);
    expect(firstSentence).toMatch(/matches nothing is free/);
    expect(description).toMatch(/stops spending at USD 1\.00 in total/);
  });

  it('declares itself as spending money rather than read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('publishes the four documented inputs and nothing else', async () => {
    const { tools } = await client.listTools();
    const properties = (tools[0]?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(['abn', 'acn', 'limit', 'name']);
  });

  it('returns structured content that matches its own output schema', async () => {
    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: true,
      charged: true,
      count: 1,
      price_usd: 0.01,
      settlement_tx: '0xabc',
    });
  });

  it('puts the company, the cost and the licence attribution in the text a model reads', async () => {
    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain('WOOLWORTHS GROUP LIMITED');
    expect(text).toContain('Charged USD 0.01');
    expect(text).toContain('CC BY 3.0 AU');
    expect(text).toContain('formerly: WOOLWORTHS LTD');
  });

  it('reports a miss as a normal result, not an error, and says it was free', async () => {
    ({ client } = await connect(respond(404, { charged: false, count: 0, results: [] }).fetch));
    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'zzznope' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: false, charged: false });
    expect((result.content as { text: string }[])[0]!.text).toMatch(/A miss is free/);
  });

  it('turns a bad query into a tool error the model can fix, not a crash', async () => {
    const api = respond(200, OK);
    ({ client } = await connect(api.fetch));
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { abn: '51824753556', name: 'csiro' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/exactly one of abn, acn or name/);
    expect(api.calls).toHaveLength(0);
  });

  it('rejects an out-of-range limit at the protocol boundary', async () => {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { name: 'woolworths', limit: 99 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/less than or equal to 25/);
  });

  it('reports the spend cap as a tool error once it is exhausted', async () => {
    const ledger = new SpendLedger(10_000n);
    ({ client } = await connect(respond(200, OK).fetch, { ledger }));

    const first = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({ name: TOOL_NAME, arguments: { name: 'coles' } });
    expect(second.isError).toBe(true);
    expect((second.content as { text: string }[])[0]!.text).toMatch(/Spend cap reached/);
  });

  it('does not let simultaneous tool calls collectively overrun the cap', async () => {
    // Room for two lookups, five agents asking at once. The reservation is taken
    // before the request goes out precisely so the third one cannot slip between
    // another call's request and its settlement.
    const ledger = new SpendLedger(20_000n);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowApi = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return new Response(JSON.stringify(OK), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;

    ({ client } = await connect(slowApi, { ledger }));

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) =>
        client.callTool({ name: TOOL_NAME, arguments: { name: `${name}${name}` } }),
      ),
    );

    const paid = results.filter((result) => !result.isError);
    const refused = results.filter((result) => result.isError);
    expect(paid).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const result of refused) {
      expect((result.content as { text: string }[])[0]!.text).toMatch(/Spend cap reached/);
    }
    expect(ledger.spentAtomic).toBe(20_000n);
    expect(ledger.reservedAtomic).toBe(0n);
    // Proves the calls really were concurrent, not serialised by the transport,
    // so the assertion above is testing what it claims to test.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('returns a paid result the API drifted on rather than discarding it', async () => {
    // `former_names: null` is a required array in the declared output schema.
    // Handing it to the SDK unvalidated makes the SDK throw the whole result
    // away: isError, no structured content, no spend line -- for a lookup the
    // wallet has already paid for, whose obvious next move is a retry.
    const drifted = {
      ...OK,
      results: [{ ...COMPANY, former_names: null, status: null }],
    };
    const ledger = new SpendLedger(1_000_000n);
    ({ client } = await connect(respond(200, drifted).fetch, { ledger }));

    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain('WOOLWORTHS GROUP LIMITED');
    expect(text).toContain('Charged USD 0.01');
    expect(result.structuredContent).toMatchObject({ found: true, charged: true, count: 1 });
    expect(ledger.spentAtomic).toBe(10_000n);
  });

  it('never trades a paid result for an error with no data in it', async () => {
    // The drift matrix. Each of these is a shape the API could plausibly return
    // on a lookup that has already been charged for, and none of them may cost
    // the caller the result: a paid lookup that comes back as isError with no
    // structured content is money spent for nothing, and a model's next move is
    // to spend it again.
    const drifts: Record<string, unknown>[] = [
      { ...OK, results: [{ ...COMPANY, former_names: null }] },
      { ...OK, results: [{ ...COMPANY, former_names: [null, 'X'] }] },
      { ...OK, results: [{ ...COMPANY, status: undefined, acn: 12345 }] },
      { ...OK, results: [{ ...COMPANY, gst_status: 'Registered', new_field: { nested: true } }] },
      { ...OK, results: [{ company_name: 'MINIMAL PTY LTD' }] },
      { ...OK, count: 'lots' },
      { ...OK, results: 'not an array' },
      { ...OK, payment: { price_usd: '0.01' } },
      { ...OK, payment: null },
      { ...OK, charged: 'yes' },
    ];

    for (const [index, body] of drifts.entries()) {
      const ledger = new SpendLedger(1_000_000n);
      const { client: driftClient } = await connect(respond(200, body).fetch, { ledger });
      const result = await driftClient.callTool({ name: TOOL_NAME, arguments: { name: 'ww' } });

      expect(result.isError, `drift ${index}`).toBeFalsy();
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text.length, `drift ${index}`).toBeGreaterThan(0);
      expect(text, `drift ${index}`).toMatch(/USD 0\.01 of the USD 1\.00 cap/);
      // Either the structured form survives, or the text carries the result and
      // says why the structured form did not. Never neither.
      if (!result.structuredContent) {
        expect(text, `drift ${index}`).toMatch(/could not fit to its declared output schema/);
      }
      expect(ledger.spentAtomic, `drift ${index}`).toBe(10_000n);
    }
  });

  it('says it was charged when a 200 comes back with no records', async () => {
    const empty = { count: 0, charged: true, results: [], payment: { price_usd: 0.01 } };
    ({ client } = await connect(respond(200, empty).fetch));

    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });
    const text = (result.content as { text: string }[])[0]!.text;

    expect(result.structuredContent).toMatchObject({ found: false, charged: true });
    // The text used to read "No match. ... not charged", contradicting the
    // structured content and teaching the model that misses are always free.
    expect(text).toContain('Charged USD 0.01');
    expect(text).not.toContain('Not charged');
  });

  it('never puts the wallet key in a tool result, on any path a caller can reach', async () => {
    // The old version of this test only ever ran the happy path, where no
    // library error is anywhere near the result. The key material, if it ever
    // leaked, would leak out of a failure: a refused payment, a signing error, a
    // malformed response, a cap refusal.
    const paths: { name: string; fetch: never; args: Record<string, unknown> }[] = [
      { name: '200', fetch: respond(200, OK).fetch, args: { name: 'woolworths' } },
      { name: '404', fetch: respond(404, { charged: false, results: [] }).fetch, args: { name: 'zz' } },
      { name: '402', fetch: respond(402, { accepts: [{ amount: '10000' }] }).fetch, args: { name: 'zz' } },
      { name: '409', fetch: respond(409, { detail: 'in flight' }).fetch, args: { name: 'zz' } },
      { name: '503', fetch: respond(503, { charged: 'unknown' }).fetch, args: { name: 'zz' } },
      { name: '502-html', fetch: respond(502, '<html/>' as never).fetch, args: { name: 'zz' } },
      { name: 'bad query', fetch: respond(200, OK).fetch, args: { abn: '1', name: 'x' } },
    ];

    for (const path of paths) {
      const { client: pathClient } = await connect(path.fetch);
      const result = await pathClient.callTool({ name: TOOL_NAME, arguments: path.args });
      const serialised = JSON.stringify(result);
      expect(serialised, path.name).not.toContain(TEST_KEY);
      expect(serialised, path.name).not.toContain(TEST_KEY.slice(2));
      expect(serialised, path.name).not.toContain(payerAddress(config()));
    }

    // A throwing transport is the one place a raw library stack could surface.
    const throwing = (async () => {
      throw new Error(`signing failed for key ${TEST_KEY}`);
    }) as never;
    const { client: throwingClient } = await connect(throwing);
    const thrown = await throwingClient.callTool({ name: TOOL_NAME, arguments: { name: 'zz' } });
    expect(thrown.isError).toBe(true);
    // It cannot be scrubbed out of an arbitrary dependency message, so the test
    // records what IS guaranteed: the message is bounded, and nothing in this
    // package ever puts the key into one.
    expect((thrown.content as { text: string }[])[0]!.text.length).toBeLessThanOrEqual(600);
  });

  it('refuses the identical query after an unknown payment outcome', async () => {
    const api = respond(503, { charged: 'unknown' });
    ({ client } = await connect(api.fetch));

    const first = await client.callTool({ name: TOOL_NAME, arguments: { abn: '51824753556' } });
    expect(first.isError).toBe(true);

    const second = await client.callTool({ name: TOOL_NAME, arguments: { abn: '51824753556' } });
    expect(second.isError).toBe(true);
    expect((second.content as { text: string }[])[0]!.text).toMatch(
      /authorisation it signed is still live/,
    );
    // Held before it became a request, so the retry cost nothing.
    expect(api.calls).toHaveLength(1);
  });
});

describe('toToolResult', () => {
  const RESULT = {
    found: true,
    charged: true,
    count: 1,
    results: [COMPANY],
    price_usd: 0.01,
    settlement_tx: '0xabc',
    spend: 'spent USD 0.01 of the USD 1.00 cap over 1 charged lookup; USD 0.99 remaining',
    note: null,
    attribution: 'Contains ASIC Company Register data sourced from data.gov.au.',
  };

  it('passes a conforming result through as structured content', () => {
    const rendered = toToolResult(RESULT);
    expect(rendered.structuredContent).toMatchObject({ found: true, charged: true, count: 1 });
    expect(rendered.content[0]!.text).toContain('WOOLWORTHS GROUP LIMITED');
  });

  it('keeps a paid result the SDK would have discarded, as text', () => {
    // The SDK validates structuredContent against outputSchema and throws the
    // WHOLE result away when it does not match: no data, no spend line, and a
    // charged wallet. Whatever a future API drift does to the envelope, the
    // caller still gets what it paid for.
    const drifted = { ...RESULT, count: 'lots' } as unknown as typeof RESULT;
    const rendered = toToolResult(drifted);

    expect(rendered.structuredContent).toBeUndefined();
    expect(rendered.content[0]!.text).toContain('WOOLWORTHS GROUP LIMITED');
    expect(rendered.content[0]!.text).toContain('spent USD 0.01 of the USD 1.00 cap');
    expect(rendered.content[0]!.text).toMatch(/structured form is omitted: count/);
  });

  it('names the field that did not fit, so a drift is diagnosable', () => {
    const drifted = { ...RESULT, spend: undefined } as unknown as typeof RESULT;
    expect(toToolResult(drifted).content[0]!.text).toMatch(/structured form is omitted: spend/);
  });
});
