#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { formatUsd } from './money.js';
import { payerAddress } from './payment.js';
import { buildServer, SERVER_VERSION } from './server.js';

/**
 * stdout belongs to the JSON-RPC stream and nothing else. Every diagnostic here
 * goes to stderr, where an MCP client shows it as server log output instead of
 * failing to parse it as a message.
 */
function note(line: string): void {
  process.stderr.write(`asic-lookup-mcp: ${line}\n`);
}

// stdout is the JSON-RPC stream. Nothing in src writes to it, but a dependency
// that ever calls console.log would corrupt the transport, so the invariant is
// made structural rather than left resting on that staying true.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      note(`refusing to start.\n\n${error.message}\n`);
      note('See https://github.com/keitaemsden-lab/asic-lookup-mcp#configuration');
      process.exit(1);
    }
    throw error;
  }

  const { server, ledger } = buildServer(config);

  note(
    `v${SERVER_VERSION} ready. Paying from ${payerAddress(config)} to ${config.expectedPayTo} ` +
      `on Base, up to USD ${formatUsd(config.maxPricePerCallAtomic)} per lookup and ` +
      `USD ${formatUsd(ledger.capAtomicValue)} in total before it stops. Authorisations it signs ` +
      `stay spendable for at most ${config.maxAuthorisationSeconds}s and are held against the cap ` +
      'until they expire, whether or not they settle.',
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  note(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
