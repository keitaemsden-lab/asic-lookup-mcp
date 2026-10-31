import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LookupError } from '../src/lookup.js';
import { PaymentRefused } from '../src/payment.js';
import { buildServer, TOOL_NAME } from '../src/server.js';

/**
 * renderError is private to server.ts, so every branch is driven the way a
 * client reaches it: a tool call whose injected fetch throws. Nothing here
 * touches the network -- the fetch never signs, so no signature exists and the
 * thrown value reaches renderError unwrapped.
 */

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function config() {
  return loadConfig({
    PRIVATE_KEY: TEST_KEY,
    SPEND_CAP_USD: '1.00',
    API_BASE_URL: 'https://api.example.test',
  });
}

/** Call the tool once with a fetch that throws `thrown`, and return the error text. */
async function errorTextFor(thrown: unknown, args: Record<string, unknown> = { name: 'woolworths' }) {
  let calls = 0;
  const fetchWithPay = (async () => {
    calls += 1;
    throw thrown;
  }) as never;
  const { server } = buildServer(config(), { fetchWithPay });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: TOOL_NAME, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return { text: content[0]!.text, calls };
}

const LOOKUP_PREFIX = 'Lookup failed. ';
const PAYMENT_PREFIX = 'Payment refused. Nothing was charged: this server ';

describe('renderError through a tool call', () => {
  it('renders a TimeoutError as the fixed unknown-settlement text', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const { text, calls } = await errorTextFor(timeout);
    expect(calls).toBe(1);
    expect(text).toBe(
      'Lookup failed. The API did not answer in time. Whether the payment settled is unknown; ' +
        'if you retry and it charges again, that is why.',
    );
    // The raw abort message is replaced, not appended.
    expect(text).not.toContain('aborted');
  });

  it('renders a DOMException TimeoutError (what AbortSignal.timeout throws) the same way', async () => {
    const { text } = await errorTextFor(new DOMException('signal timed out', 'TimeoutError'));
    expect(text).toMatch(/^Lookup failed\. The API did not answer in time\./);
  });

  it('prefixes a LookupError with "Lookup failed." and keeps its message verbatim', async () => {
    // A bad query throws LookupError before any fetch happens.
    const { text, calls } = await errorTextFor(new Error('unreachable'), { acn: '123' });
    expect(calls).toBe(0);
    expect(text).toBe('Lookup failed. an ACN is 9 digits; got 3 character(s).');
    expect(text.startsWith(PAYMENT_PREFIX)).toBe(false);
  });

  it('takes the LookupError branch before the refusal-text match', async () => {
    // A LookupError thrown from the transport, whose text would also match the
    // payment branch: the class check wins, and the message is not clipped.
    const message = 'refused to pay for this lookup: ' + 'y'.repeat(600);
    const { text } = await errorTextFor(new LookupError(message));
    expect(text).toBe(`Lookup failed. ${message}`);
  });

  it('prefixes a PaymentRefused with "Payment refused. Nothing was charged"', async () => {
    const refusal = new PaymentRefused('refused to pay for this lookup: synthetic payee mismatch.');
    const { text } = await errorTextFor(refusal);
    expect(text).toBe(
      'Payment refused. Nothing was charged: this server refused to pay for this lookup: ' +
        'synthetic payee mismatch.',
    );
    expect(text.startsWith(LOOKUP_PREFIX)).toBe(false);
  });

  it('recognises a wrapped refusal by its text and drops the wrapper prefix', async () => {
    const wrapped = new Error('x402 client: refused to pay for this lookup: synthetic reason.');
    const { text } = await errorTextFor(wrapped);
    expect(text).toBe(
      'Payment refused. Nothing was charged: this server refused to pay for this lookup: ' +
        'synthetic reason.',
    );
  });

  it('passes a short generic Error message through after "Lookup failed."', async () => {
    const { text } = await errorTextFor(new Error('synthetic transport failure'));
    expect(text).toBe('Lookup failed. synthetic transport failure');
  });

  it('clips a generic Error message to exactly 500 characters', async () => {
    const message = 'abcdefghij'.repeat(60); // 600 characters
    const { text } = await errorTextFor(new Error(message));
    expect(text.startsWith(LOOKUP_PREFIX)).toBe(true);
    const body = text.slice(LOOKUP_PREFIX.length);
    expect(body).toHaveLength(500);
    expect(body).toBe(message.slice(0, 500));
    expect(text).toHaveLength(LOOKUP_PREFIX.length + 500);
  });

  it('leaves a generic message of exactly 500 characters unclipped', async () => {
    const message = 'x'.repeat(499) + 'Z';
    const { text } = await errorTextFor(new Error(message));
    expect(text).toBe(`${LOOKUP_PREFIX}${message}`);
  });

  it('renders a thrown string with String() after "Lookup failed."', async () => {
    const { text } = await errorTextFor('synthetic string failure');
    expect(text).toBe('Lookup failed. synthetic string failure');
  });

  it('renders a thrown plain object and undefined with String()', async () => {
    expect((await errorTextFor({ code: 42 })).text).toBe('Lookup failed. [object Object]');
    expect((await errorTextFor(undefined)).text).toBe('Lookup failed. undefined');
    expect((await errorTextFor(null)).text).toBe('Lookup failed. null');
  });

  it('clips a long thrown string to 500 characters too', async () => {
    const thrown = 'q'.repeat(450) + 'r'.repeat(150);
    const { text } = await errorTextFor(thrown);
    expect(text).toBe(`${LOOKUP_PREFIX}${thrown.slice(0, 500)}`);
  });

  it('routes a thrown non-Error string that names a refusal to the payment branch', async () => {
    const { text } = await errorTextFor('refused to pay for this lookup: synthetic string refusal.');
    expect(text).toBe(
      'Payment refused. Nothing was charged: this server refused to pay for this lookup: ' +
        'synthetic string refusal.',
    );
  });
});
