import { describe, expect, it } from 'vitest';
import { buildPolicy, PaymentRefused, screenRequirement } from '../src/payment.js';
import { USDC_BASE } from '../src/config.js';
import challenge from './fixtures/challenge-402.json' with { type: 'json' };

const CAP = 10_000n; // USD 0.01

/** The v2 accepts entry the live API actually served, recorded 2026-09-09. */
const live = challenge.v2Document.accepts[0] as unknown as Record<string, unknown>;
const liveV1 = challenge.v1Body.accepts[0] as unknown as Record<string, unknown>;

describe('screenRequirement', () => {
  it('accepts the requirement the live API serves, at the advertised price', () => {
    expect(screenRequirement(live, CAP)).toEqual({ ok: true, atomic: 10_000n });
  });

  it('accepts the v1 spelling of the same requirement', () => {
    expect(screenRequirement(liveV1, CAP)).toEqual({ ok: true, atomic: 10_000n });
  });

  it('refuses a scheme whose semantics have not been audited', () => {
    const verdict = screenRequirement({ ...live, scheme: 'upto' }, CAP);
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { reason: string }).reason).toMatch(/is not "exact"/);
  });

  it('refuses a chain that is not Base mainnet', () => {
    for (const network of ['eip155:1', 'base-sepolia', 'solana:mainnet', '']) {
      const verdict = screenRequirement({ ...live, network }, CAP);
      expect(verdict, network).toMatchObject({ ok: false });
      expect((verdict as { reason: string }).reason).toMatch(/is not Base mainnet/);
    }
  });

  it('accepts every spelling of Base mainnet the two wire versions use', () => {
    for (const network of ['base', 'eip155:8453', 'base-mainnet', 'EIP155:8453']) {
      expect(screenRequirement({ ...live, network }, CAP), network).toMatchObject({ ok: true });
    }
  });

  it('refuses a token that is not USDC on Base', () => {
    const verdict = screenRequirement(
      { ...live, asset: '0x0000000000000000000000000000000000000001' },
      CAP,
    );
    expect((verdict as { reason: string }).reason).toMatch(/is not USDC on Base/);
  });

  it('is not case sensitive about the USDC address', () => {
    expect(screenRequirement({ ...live, asset: USDC_BASE.toLowerCase() }, CAP)).toMatchObject({
      ok: true,
    });
  });

  it('refuses a payee that is not an address', () => {
    for (const payTo of ['', 'not-an-address', '0x1234']) {
      const verdict = screenRequirement({ ...live, payTo }, CAP);
      expect(verdict, payTo).toMatchObject({ ok: false });
    }
  });

  it('refuses a price above the ceiling the user approved', () => {
    const verdict = screenRequirement({ ...live, amount: '20000' }, CAP);
    expect((verdict as { reason: string }).reason).toMatch(
      /asking USD 0.02 for this call but MAX_PRICE_USD_PER_CALL is USD 0.01/,
    );
  });

  it('checks the price the server actually asked, not the price we expected', () => {
    // The whole point: a 402 is free to demand any number, and the number in the
    // signature is the one that leaves the wallet.
    expect(screenRequirement({ ...live, amount: '1000000000' }, CAP)).toMatchObject({ ok: false });
    expect(screenRequirement({ ...live, amount: '10000' }, CAP)).toMatchObject({ ok: true });
    expect(screenRequirement({ ...live, amount: '9999' }, CAP)).toMatchObject({ ok: true });
  });

  it('refuses an unreadable or zero price rather than guessing', () => {
    // The live v2 document carries `maxAmountRequired` alongside `amount`, so a
    // test that only blanks one of them is testing the fallback, not the refusal.
    expect(screenRequirement({ ...live, amount: '0', maxAmountRequired: '0' }, CAP)).toMatchObject({
      ok: false,
    });
    expect(
      screenRequirement({ ...live, amount: '$0.01', maxAmountRequired: '$0.01' }, CAP),
    ).toMatchObject({ ok: false });
    const noPrice = { ...live };
    delete noPrice['amount'];
    delete noPrice['maxAmountRequired'];
    expect(screenRequirement(noPrice, CAP)).toMatchObject({ ok: false });
  });
});

describe('buildPolicy', () => {
  const policy = buildPolicy(CAP);

  it('keeps the acceptable options', () => {
    expect(policy(2, [live] as never)).toHaveLength(1);
  });

  it('drops the unacceptable ones but pays the acceptable one from a mixed offer', () => {
    const kept = policy(2, [{ ...live, network: 'eip155:1' }, live] as never);
    expect(kept).toEqual([live]);
  });

  it('throws a reason a human can act on when nothing is payable', () => {
    expect(() => policy(2, [{ ...live, amount: '500000' }] as never)).toThrow(PaymentRefused);
    expect(() => policy(2, [{ ...live, amount: '500000' }] as never)).toThrow(
      /asking USD 0.50 .* MAX_PRICE_USD_PER_CALL is USD 0.01/,
    );
  });

  it('refuses an empty offer', () => {
    expect(() => policy(2, [] as never)).toThrow(/no payment options at all/);
  });
});
