import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

// A throwaway key. It has never held anything and never will.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const base = { PRIVATE_KEY: TEST_KEY, SPEND_CAP_USD: '1.00' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('refuses to start without a spend cap', () => {
    expect(() => loadConfig({ PRIVATE_KEY: TEST_KEY })).toThrow(ConfigError);
    expect(() => loadConfig({ PRIVATE_KEY: TEST_KEY })).toThrow(/SPEND_CAP_USD is required/);
  });

  it('treats an empty or whitespace SPEND_CAP_USD as absent', () => {
    expect(() => loadConfig({ ...base, SPEND_CAP_USD: '' })).toThrow(/SPEND_CAP_USD is required/);
    expect(() => loadConfig({ ...base, SPEND_CAP_USD: '   ' })).toThrow(/SPEND_CAP_USD is required/);
  });

  it('refuses a zero or negative cap', () => {
    expect(() => loadConfig({ ...base, SPEND_CAP_USD: '0' })).toThrow(/greater than zero/);
    expect(() => loadConfig({ ...base, SPEND_CAP_USD: '-1' })).toThrow(ConfigError);
  });

  it('refuses a cap below the per-call ceiling, which could never pay for anything', () => {
    expect(() =>
      loadConfig({ ...base, SPEND_CAP_USD: '0.005', MAX_PRICE_USD_PER_CALL: '0.01' }),
    ).toThrow(/no lookup could ever be paid for/);
  });

  it('refuses to start without a wallet key', () => {
    expect(() => loadConfig({ SPEND_CAP_USD: '1.00' })).toThrow(/no wallet key/);
  });

  it('refuses a key that is not 32 bytes of hex, without echoing it', () => {
    try {
      loadConfig({ SPEND_CAP_USD: '1.00', PRIVATE_KEY: '0xdeadbeef' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('deadbeef');
    }
  });

  it('refuses both PRIVATE_KEY and PRIVATE_KEY_FILE at once', () => {
    expect(() =>
      loadConfig({ ...base, PRIVATE_KEY_FILE: '/nonexistent' }),
    ).toThrow(/not both/);
  });

  it('reads the key from a file, tolerating a trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asic-mcp-'));
    const path = join(dir, 'key');
    writeFileSync(path, `${TEST_KEY}\n`);
    const config = loadConfig({ SPEND_CAP_USD: '1.00', PRIVATE_KEY_FILE: path });
    expect(config.privateKey).toBe(TEST_KEY);
  });

  it('accepts a key without the 0x prefix', () => {
    const config = loadConfig({ SPEND_CAP_USD: '1.00', PRIVATE_KEY: TEST_KEY.slice(2) });
    expect(config.privateKey).toBe(TEST_KEY);
  });

  it('reports a missing key file as configuration, not a crash', () => {
    expect(() =>
      loadConfig({ SPEND_CAP_USD: '1.00', PRIVATE_KEY_FILE: '/no/such/file/here' }),
    ).toThrow(ConfigError);
  });

  it('defaults the per-call ceiling to the advertised price', () => {
    expect(loadConfig(base).maxPricePerCallAtomic).toBe(10_000n);
  });

  it('carries the caps through as atomic units', () => {
    const config = loadConfig({ ...base, SPEND_CAP_USD: '2.50', MAX_PRICE_USD_PER_CALL: '0.02' });
    expect(config.spendCapAtomic).toBe(2_500_000n);
    expect(config.maxPricePerCallAtomic).toBe(20_000n);
  });

  it('defaults to the production API over https and strips a trailing slash', () => {
    expect(loadConfig(base).apiBaseUrl).toBe('https://api.nightshiftbuilds.com');
    expect(loadConfig({ ...base, API_BASE_URL: 'https://example.test/' }).apiBaseUrl).toBe(
      'https://example.test',
    );
  });

  it('refuses a plaintext API base url, because the payment header is a credential', () => {
    expect(() => loadConfig({ ...base, API_BASE_URL: 'http://example.test' })).toThrow(/must be https/);
    expect(loadConfig({ ...base, API_BASE_URL: 'http://localhost:8000' }).apiBaseUrl).toBe(
      'http://localhost:8000',
    );
  });

  it('bounds the request timeout', () => {
    expect(loadConfig(base).requestTimeoutMs).toBe(45_000);
    expect(loadConfig({ ...base, REQUEST_TIMEOUT_MS: '5000' }).requestTimeoutMs).toBe(5_000);
    expect(() => loadConfig({ ...base, REQUEST_TIMEOUT_MS: '10' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, REQUEST_TIMEOUT_MS: 'soon' })).toThrow(ConfigError);
  });
});
