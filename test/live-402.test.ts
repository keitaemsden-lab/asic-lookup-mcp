import { describe, expect, it } from 'vitest';
import { atomicFromRequirement, formatUsd } from '../src/money.js';
import { screenRequirement } from '../src/payment.js';
import { DEFAULT_API_BASE_URL } from '../src/config.js';

/**
 * The one test that touches the real API.
 *
 * It makes an UNPAID request and reads the 402. That is free by design -- the
 * challenge is the API's published price list -- so this spends nothing, signs
 * nothing, and needs no wallet key. What it is for is catching the failure this
 * package's unit tests structurally cannot: the live endpoint changing its price,
 * its payee, its token or its chain out from under a recorded fixture.
 *
 * Set SKIP_LIVE_TESTS=1 to skip it offline.
 */
const skip = process.env['SKIP_LIVE_TESTS'] === '1';
const base = process.env['API_BASE_URL']?.replace(/\/+$/, '') ?? DEFAULT_API_BASE_URL;

describe.skipIf(skip)('the live endpoint (unpaid, free)', () => {
  it('answers 402 with a price in both live protocol versions', async () => {
    const response = await fetch(`${base}/v1/company?name=woolworths`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });

    expect(response.status).toBe(402);

    // v1: the challenge is the body.
    const body = (await response.json()) as Record<string, any>;
    expect(body.x402Version).toBe(1);
    expect(Array.isArray(body.accepts)).toBe(true);
    const v1 = body.accepts[0] as Record<string, unknown>;
    expect(atomicFromRequirement(v1)).toBeGreaterThan(0n);

    // v2: the challenge is a base64 header, and a v1 client never sees it.
    const header = response.headers.get('PAYMENT-REQUIRED');
    expect(header, 'PAYMENT-REQUIRED header').toBeTruthy();
    const v2document = JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as Record<string, any>;
    expect(v2document.x402Version).toBe(2);
    const v2 = v2document.accepts[0] as Record<string, unknown>;
    expect(atomicFromRequirement(v2)).toBeGreaterThan(0n);

    // Both documents must describe the same payment, or one of them is a trap.
    expect(atomicFromRequirement(v2)).toBe(atomicFromRequirement(v1));
    expect(String(v2['payTo']).toLowerCase()).toBe(String(v1['payTo']).toLowerCase());
    expect(String(v2['asset']).toLowerCase()).toBe(String(v1['asset']).toLowerCase());
  });

  it('is still asking for something this server would agree to sign', async () => {
    const response = await fetch(`${base}/v1/company?name=woolworths`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const header = response.headers.get('PAYMENT-REQUIRED');
    const document = JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as Record<string, any>;
    const requirement = document.accepts[0] as Record<string, unknown>;

    // The default per-call ceiling. If this fails, the endpoint moved its price
    // and the README, the tool description and the default all need revisiting.
    const verdict = screenRequirement(requirement, 10_000n);
    expect(
      verdict,
      `live requirement was ${JSON.stringify(requirement)}`,
    ).toMatchObject({ ok: true });
    expect(formatUsd((verdict as { atomic: bigint }).atomic)).toBe('0.01');
  });

  it('charges nothing for a malformed query, and says so before any payment', async () => {
    // Zero identifiers: rejected before the paywall, so this is free too.
    const response = await fetch(`${base}/v1/company`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(400);
  });
});
