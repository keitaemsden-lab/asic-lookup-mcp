import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADVERTISED_PRICE_USD } from '../src/config.js';
import { SERVER_VERSION } from '../src/server.js';

/**
 * The version and the price are each written down in several places that
 * nothing ties together: package.json, server.json (the MCP registry entry),
 * the source, and the README. A release that bumps one and not the others
 * publishes a registry entry pointing at the wrong npm version, or a README
 * quoting a price the server no longer advertises. These tests only pin
 * agreement; they do not make any copy derive from another.
 */

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

interface ServerJson {
  version: string;
  description: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    environmentVariables?: Array<{ name: string; default?: string }>;
  }>;
}

const pkg = JSON.parse(read('package.json')) as { name: string; version: string; mcpName: string };
const serverJson = JSON.parse(read('server.json')) as ServerJson;
const readme = read('README.md');

/** Every semver-looking string in the README: install pins, badges, changelog notes. */
const readmeVersions = [...readme.matchAll(/(?<![\d.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.]*\d)/g)].map(
  (m) => m[1],
);

/**
 * Per-call prices the README states: "USD 0.01 per successful lookup" and the
 * MAX_PRICE_USD_PER_CALL default in the configuration table.
 */
const readmePrices = [
  ...[...readme.matchAll(/USD\s+(\d+(?:\.\d+)?)\s+per\b/g)].map((m) => m[1]),
  ...[...readme.matchAll(/\|\s*`MAX_PRICE_USD_PER_CALL`\s*\|[^|]*\|\s*`(\d+(?:\.\d+)?)`\s*\|/g)].map((m) => m[1]),
];

describe('version agreement', () => {
  it('package.json version is a semver string', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('server.json top-level version equals package.json version', () => {
    expect(serverJson.version).toBe(pkg.version);
  });

  it('server.json lists at least one package', () => {
    expect(serverJson.packages.length).toBeGreaterThan(0);
  });

  it.each(serverJson.packages.map((p, i) => [i, p] as const))(
    'server.json packages[%i].version equals package.json version',
    (_i, p) => {
      expect(p.version).toBe(pkg.version);
    },
  );

  it('SERVER_VERSION in src/server.ts equals package.json version', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('server.json npm package identifier equals package.json name', () => {
    const npm = serverJson.packages.filter((p) => p.registryType === 'npm');
    expect(npm.length).toBeGreaterThan(0);
    for (const p of npm) expect(p.identifier).toBe(pkg.name);
  });

  it('server.json name equals package.json mcpName', () => {
    expect(serverJson.name).toBe(pkg.mcpName);
  });

  if (readmeVersions.length === 0) {
    it('README pins no version, so there is nothing for it to disagree with', () => {
      // If a pinned install snippet or badge is added later, the branch below
      // takes over and checks it.
      expect(readme).not.toMatch(/asic-lookup-mcp@\d/);
      expect(readmeVersions).toEqual([]);
    });
  } else {
    it.each(readmeVersions)('README pins version %s, which equals package.json version', (v) => {
      expect(v).toBe(pkg.version);
    });
  }
});

describe('price agreement', () => {
  it('README states a per-call price', () => {
    expect(readmePrices.length).toBeGreaterThan(0);
  });

  it.each(readmePrices)('README per-call price %s equals ADVERTISED_PRICE_USD', (price) => {
    expect(price).toBe(ADVERTISED_PRICE_USD);
  });

  it('server.json description and MAX_PRICE_USD_PER_CALL default equal ADVERTISED_PRICE_USD', () => {
    expect(serverJson.description).toContain(`USD ${ADVERTISED_PRICE_USD} per`);
    for (const p of serverJson.packages) {
      const max = p.environmentVariables?.find((e) => e.name === 'MAX_PRICE_USD_PER_CALL');
      if (max) expect(max.default).toBe(ADVERTISED_PRICE_USD);
    }
  });
});
