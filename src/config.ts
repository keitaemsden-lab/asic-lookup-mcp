import { readFileSync } from 'node:fs';
import { formatUsd, parseUsd } from './money.js';

/** USDC on Base mainnet. The only asset this server will ever sign a payment for. */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Base mainnet, in every spelling the two live x402 wire versions use for it. */
export const BASE_NETWORKS = new Set(['base', 'eip155:8453', 'base-mainnet']);

export const DEFAULT_API_BASE_URL = 'https://api.nightshiftbuilds.com';

/** The endpoint's advertised price. Also the default per-call ceiling. */
export const ADVERTISED_PRICE_USD = '0.01';

export interface Config {
  apiBaseUrl: string;
  /** Never logged, never returned in a tool result, never put in an error message. */
  privateKey: `0x${string}`;
  /** Cumulative ceiling for the life of this process, in atomic USDC units. */
  spendCapAtomic: bigint;
  /** Per-lookup ceiling. A single 402 asking for more than this is refused, not paid. */
  maxPricePerCallAtomic: bigint;
  requestTimeoutMs: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function readPrivateKey(env: NodeJS.ProcessEnv): `0x${string}` {
  const inline = env['PRIVATE_KEY']?.trim();
  const path = env['PRIVATE_KEY_FILE']?.trim();

  if (inline && path) {
    throw new ConfigError(
      'set either PRIVATE_KEY or PRIVATE_KEY_FILE, not both, so there is no doubt which key signs.',
    );
  }

  let value: string;
  if (inline) {
    value = inline;
  } else if (path) {
    try {
      value = readFileSync(path, 'utf8').trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`PRIVATE_KEY_FILE could not be read: ${reason}`);
    }
    if (!value) {
      throw new ConfigError(`PRIVATE_KEY_FILE (${path}) is empty.`);
    }
  } else {
    throw new ConfigError(
      'no wallet key. Set PRIVATE_KEY to a 0x-prefixed Base private key, or PRIVATE_KEY_FILE ' +
        'to a file containing one (preferred: it keeps the key out of your MCP client config).',
    );
  }

  const key = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // Deliberately says nothing about the value itself.
    throw new ConfigError(
      'the wallet key is not a 32-byte hex private key (expected 0x followed by 64 hex characters).',
    );
  }
  return key as `0x${string}`;
}

function readPositiveUsd(env: NodeJS.ProcessEnv, name: string, fallback?: string): bigint {
  const raw = env[name]?.trim();
  if (!raw) {
    if (fallback === undefined) {
      throw new ConfigError(`${name} is required.`);
    }
    return parseUsd(fallback);
  }
  let atomic: bigint;
  try {
    atomic = parseUsd(raw);
  } catch (error) {
    throw new ConfigError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (atomic <= 0n) {
    throw new ConfigError(`${name} must be greater than zero; got ${raw}.`);
  }
  return atomic;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env['REQUEST_TIMEOUT_MS']?.trim();
  if (!raw) return 45_000;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`REQUEST_TIMEOUT_MS must be a whole number of milliseconds; got ${raw}.`);
  }
  const value = Number(raw);
  if (value < 1_000 || value > 300_000) {
    throw new ConfigError(`REQUEST_TIMEOUT_MS must be between 1000 and 300000; got ${raw}.`);
  }
  return value;
}

/**
 * Load and validate configuration, refusing to produce a Config at all unless a
 * spend cap was set deliberately.
 *
 * The cap is mandatory on purpose. This server spends the user's own money on
 * every successful lookup, and an agent that can call a tool in a loop can spend
 * in a loop. There is no default that is honest here: any number we picked would
 * be us deciding how much of someone else's money is acceptable to lose.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env['SPEND_CAP_USD']?.trim()) {
    throw new ConfigError(
      'SPEND_CAP_USD is required and has no default.\n\n' +
        'This server pays for each lookup from your own wallet, so it will not start until you ' +
        'have said how much it may spend in total before it stops. Set SPEND_CAP_USD to a whole ' +
        `dollar amount, e.g. SPEND_CAP_USD=1.00 (about ${Math.floor(1 / Number(ADVERTISED_PRICE_USD))} lookups at the current price).`,
    );
  }

  const spendCapAtomic = readPositiveUsd(env, 'SPEND_CAP_USD');
  const maxPricePerCallAtomic = readPositiveUsd(env, 'MAX_PRICE_USD_PER_CALL', ADVERTISED_PRICE_USD);

  if (maxPricePerCallAtomic > spendCapAtomic) {
    throw new ConfigError(
      `SPEND_CAP_USD (${formatUsd(spendCapAtomic)}) is below MAX_PRICE_USD_PER_CALL ` +
        `(${formatUsd(maxPricePerCallAtomic)}), so no lookup could ever be paid for. ` +
        'Raise the total cap or lower the per-call ceiling.',
    );
  }

  const apiBaseUrl = (env['API_BASE_URL']?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new ConfigError(`API_BASE_URL is not a URL: ${apiBaseUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new ConfigError(
      `API_BASE_URL must be https (a payment header over http is a credential in cleartext); got ${apiBaseUrl}`,
    );
  }

  return {
    apiBaseUrl,
    privateKey: readPrivateKey(env),
    spendCapAtomic,
    maxPricePerCallAtomic,
    requestTimeoutMs: readTimeoutMs(env),
  };
}
