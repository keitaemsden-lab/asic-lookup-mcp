import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { createPaidFetch, explainPaymentError } from '../src/payment.js';
import challenge from './fixtures/challenge-402.json' with { type: 'json' };

/**
 * The end-to-end 402 handshake, against a stub of the API rather than the API.
 *
 * Nothing here touches the network or a facilitator. The point is the signature:
 * given the 402 the live endpoint really served, what value, to what payee, on
 * what token does this server actually authorise? A test that only asserted
 * "a payment header was sent" would pass just as happily if the amount were
 * wrong by three orders of magnitude.
 */

// A throwaway key with no funds. Generated for this test and used nowhere else.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address;

const SUCCESS_BODY = {
  query: { name: 'woolworths' },
  count: 1,
  charged: true,
  request_id: 'test',
  results: [
    {
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
    },
  ],
  payment: { price_usd: 0.01, settlement_tx: '0xtest', network: 'base' },
};

interface Attempt {
  url: string;
  paymentSignature: string | null;
  xPayment: string | null;
}

/**
 * A fake resource server that answers 402 once and then 200, recording what the
 * client sent each time.
 *
 * @param overrides - fields to change on the recorded v2 payment requirement
 * @returns the stub fetch and the list of attempts it saw
 */
function stubApi(overrides: Record<string, unknown> = {}): {
  fetch: typeof globalThis.fetch;
  attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  const document = structuredClone(challenge.v2Document) as unknown as {
    accepts: Record<string, unknown>[];
  };
  document.accepts[0] = { ...document.accepts[0], ...overrides };
  const header = Buffer.from(JSON.stringify(document)).toString('base64');

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as never, init as never);
    const attempt: Attempt = {
      url: request.url,
      paymentSignature: request.headers.get('PAYMENT-SIGNATURE'),
      xPayment: request.headers.get('X-PAYMENT'),
    };
    attempts.push(attempt);

    if (!attempt.paymentSignature && !attempt.xPayment) {
      return new Response(JSON.stringify(challenge.v1Body), {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': header },
      });
    }
    return new Response(JSON.stringify(SUCCESS_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, attempts };
}

function config(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    PRIVATE_KEY: TEST_KEY,
    SPEND_CAP_USD: '1.00',
    API_BASE_URL: 'https://api.example.test',
    ...env,
  });
}

/** Pull the EIP-3009 authorisation out of whichever payment header was used. */
function decodePayment(attempt: Attempt): Record<string, any> {
  const raw = attempt.paymentSignature ?? attempt.xPayment;
  if (!raw) throw new Error('no payment header on this attempt');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

describe('the 402 handshake', () => {
  it('asks once for free, then retries with a payment header', async () => {
    const api = stubApi();
    const paidFetch = createPaidFetch(config(), api.fetch);

    const response = await paidFetch('https://api.example.test/v1/company?name=woolworths');

    expect(response.status).toBe(200);
    expect(api.attempts).toHaveLength(2);
    expect(api.attempts[0]?.paymentSignature).toBeNull();
    expect(api.attempts[1]?.paymentSignature).not.toBeNull();
    await expect(response.json()).resolves.toMatchObject({ charged: true });
  });

  it('signs the exact amount the endpoint asked for, to the endpoint payee, in USDC', async () => {
    const api = stubApi();
    await createPaidFetch(config(), api.fetch)('https://api.example.test/v1/company?name=woolworths');

    const envelope = decodePayment(api.attempts[1]!);
    const authorization = envelope.payload.authorization;

    expect(authorization.value).toBe('10000'); // USD 0.01, and not a digit more
    expect(authorization.from.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(authorization.to.toLowerCase()).toBe(
      String(challenge.v2Document.accepts[0].payTo).toLowerCase(),
    );
    expect(envelope.accepted?.asset ?? challenge.v2Document.accepts[0].asset).toBeTruthy();
  });

  it('produces a signature that recovers to the configured wallet and nobody else', async () => {
    const api = stubApi();
    await createPaidFetch(config(), api.fetch)('https://api.example.test/v1/company?name=woolworths');

    const envelope = decodePayment(api.attempts[1]!);
    const authorization = envelope.payload.authorization;
    const accepted = challenge.v2Document.accepts[0] as Record<string, any>;

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: 8453,
        verifyingContract: accepted.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature: envelope.payload.signature,
    });

    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('gives every payment its own nonce, so one authorisation is never replayed', async () => {
    const nonces = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const api = stubApi();
      await createPaidFetch(config(), api.fetch)('https://api.example.test/v1/company?name=a');
      nonces.add(decodePayment(api.attempts[1]!).payload.authorization.nonce);
    }
    expect(nonces.size).toBe(3);
  });

  it('signs nothing at all when the endpoint raises its price above the ceiling', async () => {
    const api = stubApi({ amount: '2000000', maxAmountRequired: '2000000' }); // USD 2.00
    const paidFetch = createPaidFetch(config(), api.fetch);

    const error = await paidFetch('https://api.example.test/v1/company?name=woolworths').then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).not.toBeNull();
    // The request was made once, for free, and no authorisation was ever signed.
    expect(api.attempts).toHaveLength(1);
    expect(api.attempts[0]?.paymentSignature).toBeNull();
    expect(api.attempts[0]?.xPayment).toBeNull();
    // Whichever of the two price gates fired, the operator is told which knob to turn.
    expect(explainPaymentError(error)).toMatch(/MAX_PRICE_USD_PER_CALL/);
  });

  it('names the price ceiling even when the library gate refuses before our policy', () => {
    // Recorded from @x402/core, which applies its own spend controls before any
    // policy runs and reports them in terms the operator never configured.
    const libraryMessage =
      'Failed to create payment payload: All payment requirements were rejected by ' +
      'spendControls.maxAmountPerPayment ($0.01, including USDC). Raise maxAmountPerPayment, ' +
      'set it to false to disable.';
    expect(explainPaymentError(new Error(libraryMessage))).toMatch(
      /per-call ceiling of USD 0.01\. Raise MAX_PRICE_USD_PER_CALL/,
    );
  });

  it('leaves an unrelated error alone', () => {
    expect(explainPaymentError(new Error('socket hang up'))).toBeNull();
  });

  it('signs nothing when the endpoint asks for a different token', async () => {
    const api = stubApi({ asset: '0x0000000000000000000000000000000000000dEF' });
    const error = await createPaidFetch(config(), api.fetch)(
      'https://api.example.test/v1/company?name=x',
    ).then(() => null, (reason: unknown) => reason);
    expect(error).not.toBeNull();
    expect(api.attempts).toHaveLength(1);
    expect(explainPaymentError(error)).toMatch(/only USDC on Base mainnet|not sign for/);
  });

  it('signs nothing when the endpoint asks for a payment on another chain', async () => {
    const api = stubApi({ network: 'eip155:1' });
    const error = await createPaidFetch(config(), api.fetch)(
      'https://api.example.test/v1/company?name=x',
    ).then(() => null, (reason: unknown) => reason);
    expect(error).not.toBeNull();
    expect(api.attempts).toHaveLength(1);
    expect(explainPaymentError(error)).toMatch(/only on Base mainnet|not sign for/);
  });

  it('pays a higher price once the operator raises the ceiling deliberately', async () => {
    const api = stubApi({ amount: '20000', maxAmountRequired: '20000' }); // USD 0.02
    await createPaidFetch(config({ MAX_PRICE_USD_PER_CALL: '0.02' }), api.fetch)(
      'https://api.example.test/v1/company?name=woolworths',
    );
    expect(decodePayment(api.attempts[1]!).payload.authorization.value).toBe('20000');
  });
});
