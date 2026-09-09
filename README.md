# asic-lookup-mcp

An MCP server that looks up Australian companies by ABN, ACN or company name against the ASIC Company Register — about 4 million companies.

**It spends your money. USD 0.01 per successful lookup, paid automatically from a wallet you configure. A lookup that matches nothing is free, and so is a malformed one.** There is no account and no API key: the payment is the credential, under the [x402](https://x402.org) protocol, in USDC on Base mainnet.

The server will not start until you have told it a total spend cap.

## Install

Nothing to install. Point your MCP client at it with `npx` and it fetches on first run.

You need a **Base mainnet wallet holding a little USDC**. You do not need ETH: x402 `exact` payments are an off-chain EIP-3009 signature settled by a facilitator, so your wallet signs and pays no gas.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "asic-lookup": {
      "command": "npx",
      "args": ["-y", "@nightshiftbuilds/asic-lookup-mcp"],
      "env": {
        "SPEND_CAP_USD": "1.00",
        "PRIVATE_KEY_FILE": "/Users/you/.config/asic-lookup/key"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "asic-lookup": {
      "command": "npx",
      "args": ["-y", "@nightshiftbuilds/asic-lookup-mcp"],
      "env": {
        "SPEND_CAP_USD": "1.00",
        "PRIVATE_KEY_FILE": "/Users/you/.config/asic-lookup/key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add asic-lookup \
  --env SPEND_CAP_USD=1.00 \
  --env PRIVATE_KEY_FILE=$HOME/.config/asic-lookup/key \
  -- npx -y @nightshiftbuilds/asic-lookup-mcp
```

### The key file

`PRIVATE_KEY_FILE` is preferred over `PRIVATE_KEY` because a client config file is not a good home for a wallet key — it gets synced, backed up and shared in screenshots.

```bash
mkdir -p ~/.config/asic-lookup
printf '0x%s' "$YOUR_KEY_WITHOUT_0X" > ~/.config/asic-lookup/key
chmod 600 ~/.config/asic-lookup/key
```

## Configuration

| Variable | Required | Default | What it does |
|---|---|---|---|
| `SPEND_CAP_USD` | **yes** | none | Total USD this server may spend before it refuses every further lookup. Roughly 100 lookups per dollar. There is deliberately no default. |
| `PRIVATE_KEY_FILE` | one of these two | — | Path to a file containing the wallet's private key. |
| `PRIVATE_KEY` | one of these two | — | The key itself, `0x` + 64 hex characters. |
| `MAX_PRICE_USD_PER_CALL` | no | `0.01` | The most one lookup may cost. A `402` asking for more is refused, not paid. |
| `REQUEST_TIMEOUT_MS` | no | `45000` | How long to wait for the API. 1000–300000. |
| `API_BASE_URL` | no | `https://api.nightshiftbuilds.com` | Override the endpoint. Must be https. |

The cap is counted per server process. Restarting the server resets it, which is worth knowing if your client restarts servers often.

## The tool

**`lookup_australian_company`** — give exactly **one** of:

| Argument | Meaning |
|---|---|
| `abn` | Australian Business Number, 11 digits. Spaces and hyphens are ignored. |
| `acn` | Australian Company Number, 9 digits. Spaces and hyphens are ignored. |
| `name` | Company name, matched as a prefix, case insensitive. |
| `limit` | Maximum results for a name search, 1–25. Does not change the price. |

They are alternative ways to identify one company, not filters that combine, so passing two is an error rather than a narrower search.

Returns, per match: registered name, ACN or ARBN, ABN, registration status, entity type and class, registration and deregistration dates, previous state of registration, state registration number, and former names. Plus what the lookup cost, the Base settlement transaction hash, and your running total against the cap.

### What it does not have

Asking for these will not work, because the underlying dataset does not contain them:

- GST registration status, business address, state or postcode — those live in the Australian Business Register extract, a different dataset
- directors, officeholders or shareholders
- trading names, financial data
- anything about a sole trader or partnership that is not a registered company

It is also a **weekly snapshot, not the official register**. [ASIC Connect](https://connectonline.asic.gov.au) is authoritative for anything that matters legally.

## How the money works

Every lookup is one HTTP request that comes back `402 Payment Required` with a price, a payee and a token. The server signs an EIP-3009 authorisation for exactly that amount and retries. A facilitator settles it on Base and the answer comes back with the transaction hash.

Three separate limits sit in front of your signing key:

1. **Only Base mainnet.** No scheme client is registered for any other chain, so a `402` naming one has nothing that could sign it.
2. **Only USDC, only the `exact` scheme, and only up to `MAX_PRICE_USD_PER_CALL`** — checked against what the endpoint actually asked for, not against what it asked for last time. A `402` is free to demand any number it likes; the number inside the signature is the one that leaves your wallet, so that is the number that gets checked.
3. **`SPEND_CAP_USD` in total.** Counted before the request is sent, so concurrent lookups cannot collectively overrun it, and reconciled afterwards against what actually happened.

On the reconciliation: a `404` costs nothing because the API releases the authorisation, so the cap is credited back. A `503` whose `charged` field is `"unknown"` is counted **in full**, because settlement may have gone through and understating your spend is the worse error. If you see that, do not retry the identical query — the API's idempotency is keyed on the payment nonce, and a fresh nonce would be a second charge.

Nothing is broadcast from your machine, and the key is never logged, never returned in a tool result and never included in an error message.

## Data licence and attribution

The data this server returns contains **ASIC Company Register data sourced from [data.gov.au](https://data.gov.au/data/dataset/asic-companies), © Australian Securities and Investments Commission, licensed under [CC BY 3.0 AU](https://creativecommons.org/licenses/by/3.0/au/)**.

That attribution is a condition of the licence, not decoration. It ships in every tool result so it travels with the data. Keep it if you redistribute what you get back.

The full dataset is free to download from data.gov.au. This is a lookup service, not a way to obtain the dataset, and there is no cheaper path to a bulk copy through it.

## Development

```bash
npm install
npm test          # 87 tests: no wallet needed, no money spent
npm run build
```

The suite mocks the 402 handshake with a challenge recorded from the live endpoint and asserts what actually gets signed — the amount, the payee, the token, the chain, and that the signature recovers to the configured wallet. One test hits the real API **unpaid** to read its published price, which is free by design; set `SKIP_LIVE_TESTS=1` to skip it offline.

## Links

- API: <https://api.nightshiftbuilds.com> ([OpenAPI](https://api.nightshiftbuilds.com/openapi.json), [agent orientation](https://api.nightshiftbuilds.com/llms-full.txt), [terms](https://api.nightshiftbuilds.com/terms))
- Runnable Python and TypeScript clients for the same API: [asic-lookup-api-docs](https://github.com/keitaemsden-lab/asic-lookup-api-docs)
- x402: <https://x402.org>

MIT licensed. See [LICENSE](LICENSE).
