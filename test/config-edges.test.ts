import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_MAX_AUTHORISATION_SECONDS,
  DEFAULT_PAY_TO,
  loadConfig,
} from '../src/config.js';

// The same public Hardhat test key as config.test.ts. It has never held anything and never will.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const base = { PRIVATE_KEY: TEST_KEY, SPEND_CAP_USD: '1.00' } as NodeJS.ProcessEnv;

/** Run loadConfig expecting a ConfigError, and check the key never leaks into it. */
function refusal(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message.toLowerCase();
    expect(message).not.toContain(TEST_KEY.slice(2).toLowerCase());
    return error as ConfigError;
  }
  return expect.unreachable(`expected a ConfigError for ${JSON.stringify({ ...env, PRIVATE_KEY: '<key>' })}`);
}

describe('EXPECTED_PAY_TO', () => {
  it('defaults to DEFAULT_PAY_TO when unset, empty or whitespace', () => {
    expect(loadConfig(base).expectedPayTo).toBe(DEFAULT_PAY_TO);
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: '' }).expectedPayTo).toBe(DEFAULT_PAY_TO);
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: '   ' }).expectedPayTo).toBe(DEFAULT_PAY_TO);
  });

  it('uses a valid override, trimmed', () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: other }).expectedPayTo).toBe(other);
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: `  ${other}\n` }).expectedPayTo).toBe(other);
  });

  it('keeps the spelling it was given: no checksum check, no case folding', () => {
    // The payee screen in payment.ts compares case-insensitively, so config passes case through.
    const lower = DEFAULT_PAY_TO.toLowerCase();
    const upperHex = `0x${DEFAULT_PAY_TO.slice(2).toUpperCase()}`;
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: lower }).expectedPayTo).toBe(lower);
    expect(loadConfig({ ...base, EXPECTED_PAY_TO: upperHex }).expectedPayTo).toBe(upperHex);
  });

  it.each([
    ['too short', DEFAULT_PAY_TO.slice(0, -1)],
    ['too long', `${DEFAULT_PAY_TO}0`],
    ['no 0x prefix', DEFAULT_PAY_TO.slice(2)],
    ['uppercase 0X prefix', `0X${DEFAULT_PAY_TO.slice(2)}`],
    ['non-hex character', `${DEFAULT_PAY_TO.slice(0, -1)}g`],
    ['ENS name', 'nightshift.eth'],
    ['inner whitespace', `${DEFAULT_PAY_TO.slice(0, 20)} ${DEFAULT_PAY_TO.slice(20)}`],
  ])('refuses a malformed address (%s)', (_label, value) => {
    expect(refusal({ ...base, EXPECTED_PAY_TO: value }).message).toMatch(/EXPECTED_PAY_TO must be/);
  });
});

describe('MAX_AUTHORISATION_SECONDS', () => {
  it('defaults to DEFAULT_MAX_AUTHORISATION_SECONDS when unset, empty or whitespace', () => {
    expect(loadConfig(base).maxAuthorisationSeconds).toBe(DEFAULT_MAX_AUTHORISATION_SECONDS);
    expect(loadConfig({ ...base, MAX_AUTHORISATION_SECONDS: '' }).maxAuthorisationSeconds).toBe(
      DEFAULT_MAX_AUTHORISATION_SECONDS,
    );
    expect(loadConfig({ ...base, MAX_AUTHORISATION_SECONDS: '  ' }).maxAuthorisationSeconds).toBe(
      DEFAULT_MAX_AUTHORISATION_SECONDS,
    );
  });

  it('accepts exactly 30 and exactly 3600', () => {
    expect(loadConfig({ ...base, MAX_AUTHORISATION_SECONDS: '30' }).maxAuthorisationSeconds).toBe(30);
    expect(loadConfig({ ...base, MAX_AUTHORISATION_SECONDS: '3600' }).maxAuthorisationSeconds).toBe(3_600);
    expect(loadConfig({ ...base, MAX_AUTHORISATION_SECONDS: ' 300 ' }).maxAuthorisationSeconds).toBe(300);
  });

  it('refuses one past each bound', () => {
    expect(refusal({ ...base, MAX_AUTHORISATION_SECONDS: '29' }).message).toMatch(/between 30 and 3600/);
    expect(refusal({ ...base, MAX_AUTHORISATION_SECONDS: '3601' }).message).toMatch(/between 30 and 3600/);
    expect(refusal({ ...base, MAX_AUTHORISATION_SECONDS: '0' }).message).toMatch(/between 30 and 3600/);
  });

  it.each(['60.5', '60.0', '1e3', '-60', '+60', 'ten minutes', '0x3c'])(
    'refuses a non-integer value %j',
    (value) => {
      expect(refusal({ ...base, MAX_AUTHORISATION_SECONDS: value }).message).toMatch(/whole number of seconds/);
    },
  );
});

describe('REQUEST_TIMEOUT_MS bounds', () => {
  it('accepts exactly the minimum and the maximum', () => {
    expect(loadConfig({ ...base, REQUEST_TIMEOUT_MS: '1000' }).requestTimeoutMs).toBe(1_000);
    expect(loadConfig({ ...base, REQUEST_TIMEOUT_MS: '300000' }).requestTimeoutMs).toBe(300_000);
  });

  it('refuses one past each bound', () => {
    expect(refusal({ ...base, REQUEST_TIMEOUT_MS: '999' }).message).toMatch(/between 1000 and 300000/);
    expect(refusal({ ...base, REQUEST_TIMEOUT_MS: '300001' }).message).toMatch(/between 1000 and 300000/);
  });
});

describe('MAX_PRICE_USD_PER_CALL against the spend cap', () => {
  it('accepts a per-call ceiling equal to the cap', () => {
    const config = loadConfig({ ...base, SPEND_CAP_USD: '0.05', MAX_PRICE_USD_PER_CALL: '0.05' });
    expect(config.maxPricePerCallAtomic).toBe(50_000n);
    expect(config.spendCapAtomic).toBe(50_000n);
  });

  it('refuses a per-call ceiling one atomic unit above the cap', () => {
    expect(
      refusal({ ...base, SPEND_CAP_USD: '0.05', MAX_PRICE_USD_PER_CALL: '0.050001' }).message,
    ).toMatch(/no lookup could ever be paid for/);
  });
});

describe('readPositiveUsd input shapes', () => {
  // Exercised through both variables it reads, so neither can drift from the other.
  const names = ['SPEND_CAP_USD', 'MAX_PRICE_USD_PER_CALL'] as const;

  it.each(names)('%s: refuses exponent notation "1e3" rather than reading it as 1 or 1000', (name) => {
    expect(refusal({ ...base, SPEND_CAP_USD: '5000', [name]: '1e3' }).message).toMatch(
      new RegExp(`^${name}: not a plain decimal`),
    );
  });

  it.each(names)('%s: refuses a decimal comma "1,00" rather than reading it as 100 or 1', (name) => {
    expect(refusal({ ...base, SPEND_CAP_USD: '500', [name]: '1,00' }).message).toMatch(
      new RegExp(`^${name}: not a plain decimal`),
    );
  });

  it('accepts surrounding whitespace " 1.00 " as exactly one dollar', () => {
    expect(loadConfig({ ...base, SPEND_CAP_USD: ' 1.00 ' }).spendCapAtomic).toBe(1_000_000n);
    expect(
      loadConfig({ ...base, SPEND_CAP_USD: '5', MAX_PRICE_USD_PER_CALL: ' 1.00 ' }).maxPricePerCallAtomic,
    ).toBe(1_000_000n);
  });

  it('accepts exactly six decimals', () => {
    expect(
      loadConfig({ ...base, MAX_PRICE_USD_PER_CALL: '0.000001' }).maxPricePerCallAtomic,
    ).toBe(1n);
  });

  it.each(names)('%s: refuses seven decimals rather than truncating', (name) => {
    expect(refusal({ ...base, [name]: '0.0100001' }).message).toMatch(/more than 6 decimal places/);
    // Trailing zeros past six decimals are still refused: the rule is about digits written.
    expect(refusal({ ...base, [name]: '0.0100000' }).message).toMatch(/more than 6 decimal places/);
  });

  it('refuses a positive-looking amount that is zero at USDC precision', () => {
    expect(refusal({ ...base, MAX_PRICE_USD_PER_CALL: '0.000000' }).message).toMatch(/greater than zero/);
  });
});

describe('no ConfigError carries the private key', () => {
  it.each<[string, NodeJS.ProcessEnv]>([
    ['missing cap', { PRIVATE_KEY: TEST_KEY }],
    ['bad cap', { ...base, SPEND_CAP_USD: 'one dollar' }],
    ['bad per-call ceiling', { ...base, MAX_PRICE_USD_PER_CALL: '1e-2' }],
    ['cap below ceiling', { ...base, SPEND_CAP_USD: '0.001' }],
    ['bad url', { ...base, API_BASE_URL: 'not a url' }],
    ['http url', { ...base, API_BASE_URL: 'http://example.test' }],
    ['both key sources', { ...base, PRIVATE_KEY_FILE: '/nonexistent' }],
    ['malformed key', { ...base, PRIVATE_KEY: `${TEST_KEY}00` }],
    ['missing key file', { SPEND_CAP_USD: '1.00', PRIVATE_KEY_FILE: '/no/such/file/here' }],
    ['bad pay-to', { ...base, EXPECTED_PAY_TO: '0x1234' }],
    ['bad authorisation seconds', { ...base, MAX_AUTHORISATION_SECONDS: '99999' }],
    ['bad timeout', { ...base, REQUEST_TIMEOUT_MS: '1' }],
  ])('%s', (_label, env) => {
    refusal(env);
  });
});
