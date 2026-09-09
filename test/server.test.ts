import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SpendLedger } from '../src/ledger.js';
import { buildServer, TOOL_NAME } from '../src/server.js';

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

  it('never puts the wallet key in a tool result', async () => {
    const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'woolworths' } });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(TEST_KEY);
    expect(serialised).not.toContain(TEST_KEY.slice(2));
  });
});
