import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ADVERTISED_PRICE_USD, type Config } from './config.js';
import { SpendLedger } from './ledger.js';
import { formatUsd } from './money.js';
import { LookupError, lookupCompany, type LookupResult } from './lookup.js';
import { createPaidFetch, explainPaymentError, type PaidFetch } from './payment.js';
import { SpendCapExceeded } from './ledger.js';

export const SERVER_NAME = 'asic-lookup';
export const SERVER_VERSION = '0.1.0';
export const TOOL_NAME = 'lookup_australian_company';

const companySchema = z
  .object({
    company_name: z.string(),
    acn: z.string().nullable(),
    arbn: z.string().nullable(),
    abn: z.string().nullable(),
    status: z.string().nullable(),
    status_code: z.string().nullable(),
    entity_type: z.string().nullable(),
    entity_type_code: z.string().nullable(),
    class: z.string().nullable(),
    sub_class: z.string().nullable(),
    date_of_registration: z.string().nullable(),
    date_of_deregistration: z.string().nullable(),
    previous_state_of_registration: z.string().nullable(),
    state_registration_number: z.string().nullable(),
    current_name_start_date: z.string().nullable(),
    former_names: z.array(z.string()),
  })
  .partial({
    arbn: true,
    status_code: true,
    entity_type_code: true,
    class: true,
    sub_class: true,
    date_of_deregistration: true,
    previous_state_of_registration: true,
    state_registration_number: true,
    current_name_start_date: true,
    former_names: true,
  })
  .passthrough();

export const inputShape = {
  abn: z
    .string()
    .optional()
    .describe('Australian Business Number, 11 digits. Spaces and hyphens are ignored.'),
  acn: z
    .string()
    .optional()
    .describe('Australian Company Number, 9 digits. Spaces and hyphens are ignored.'),
  name: z
    .string()
    .optional()
    .describe('Company name, matched as a prefix. Case insensitive, e.g. "woolworths".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Maximum results for a name search, 1 to 25. Defaults to 25. Does not change the price.'),
};

export const outputShape = {
  found: z.boolean().describe('Whether any company matched.'),
  charged: z.boolean().describe('Whether this lookup cost money. False for a miss.'),
  count: z.number().describe('Number of matching companies returned.'),
  results: z.array(companySchema).describe('The matching company register records.'),
  price_usd: z.number().nullable().describe('What this lookup cost in USD, or null if it was free.'),
  settlement_tx: z.string().nullable().describe('Base transaction hash for the payment, if one settled.'),
  spend: z.string().describe('Running total against SPEND_CAP_USD for this server process.'),
  note: z.string().nullable().describe('Anything the caller should know about this particular result.'),
  attribution: z.string().describe('Required CC BY 3.0 AU attribution for the underlying data.'),
};

function describeTool(config: Config): string {
  return (
    `Costs USD ${ADVERTISED_PRICE_USD} per successful lookup, paid automatically in USDC on ` +
    'Base from the wallet this server is ' +
    'configured with; a query that matches nothing is free, and so is a malformed one. ' +
    'Resolves an Australian company by ABN, ACN or name against the ASIC Company Register ' +
    '(about 4 million companies) and returns the registered name, ACN or ARBN, ABN, registration ' +
    'status, entity type and class, registration and deregistration dates, previous state of ' +
    'registration and former names. Give exactly one of abn, acn or name. ' +
    'It does NOT have GST status, business address, state or postcode, directors or officeholders, ' +
    'trading names, financial data, or anything about a sole trader or partnership that is not a ' +
    'registered company. It is a weekly snapshot, not the official register: ASIC Connect is ' +
    `authoritative for anything legal. This server stops spending at USD ${formatUsd(config.spendCapAtomic)} in total.`
  );
}

export function buildServer(
  config: Config,
  deps: { fetchWithPay?: PaidFetch; ledger?: SpendLedger } = {},
): { server: McpServer; ledger: SpendLedger } {
  const ledger = deps.ledger ?? new SpendLedger(config.spendCapAtomic);
  const fetchWithPay = deps.fetchWithPay ?? createPaidFetch(config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Australian company register lookups. Every successful lookup spends real money from ' +
        "the operator's own wallet, so look a company up when you need its register record, not " +
        'to browse. A miss costs nothing.',
    },
  );

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Look up an Australian company (paid)',
      description: describeTool(config),
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        // Not readOnly: it reads public data, but it moves money out of a wallet
        // to do it, and a client deciding whether to auto-approve should see that.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await lookupCompany(args, { config, fetchWithPay, ledger });
        return {
          content: [{ type: 'text' as const, text: renderText(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: renderError(error) }], isError: true };
      }
    },
  );

  return { server, ledger };
}

function renderText(result: LookupResult): string {
  if (!result.found) {
    return `No match. ${result.note ?? ''}\n\n${result.spend}`.trim();
  }
  const lines = result.results.map((company) => {
    const identifier = company.acn ?? company.arbn ?? company.abn ?? '(no number)';
    const parts = [
      company.company_name,
      identifier,
      company.status,
      company.entity_type,
      company.date_of_registration ? `registered ${company.date_of_registration}` : null,
    ].filter(Boolean);
    const former = company.former_names?.length ? `\n    formerly: ${company.former_names.join(', ')}` : '';
    return `  ${parts.join('  |  ')}${former}`;
  });
  const cost = result.charged
    ? `Charged USD ${result.price_usd ?? '0.01'}${result.settlement_tx ? ` (tx ${result.settlement_tx})` : ''}.`
    : 'Not charged.';
  return [
    `${result.count} match${result.count === 1 ? '' : 'es'}:`,
    ...lines,
    '',
    `${cost} ${result.spend}.`,
    '',
    result.attribution,
  ].join('\n');
}

function renderError(error: unknown): string {
  if (error instanceof SpendCapExceeded) return `Spend cap reached. ${error.message}`;
  if (error instanceof LookupError) return `Lookup failed. ${error.message}`;

  const payment = explainPaymentError(error);
  if (payment) return `Payment refused. Nothing was charged: this server ${payment}`;

  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Lookup failed. The API did not answer in time. Whether the payment settled is unknown; ' +
      'if you retry and it charges again, that is why.';
  }
  // Anything else the x402 client throws lands here. Its messages name the
  // payment problem, and none of them contain key material.
  const message = error instanceof Error ? error.message : String(error);
  return `Lookup failed. ${message}`;
}
