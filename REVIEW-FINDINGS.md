# Independent review, 2026-09-09 — spend-safety findings

An independent Opus reviewer went over the first commit and **empirically proved**, by running the
built code against stub servers, that `SPEND_CAP_USD` does not yet mean what this package claims it
means. Findings below are confirmed against the source. **Do not point a funded wallet at this until
the blockers are fixed.** Nothing is published to npm.

Codex was unavailable (out of credits), so a Claude Opus reviewer was substituted.

## Blockers — must fix before publish

### B1. The ledger accounts for *settlements*, but what leaves a wallet is a *signature*
Every `reservation.release()` path in `src/lookup.ts` (404, 402, 429, throw, fallthrough) runs
*after* `wrapFetchWithPayment` has already transmitted a signed EIP-3009 authorisation. "Released"
on a 404 is the server's *promise* not to settle; the signature stays valid until `validBefore` and
the client cannot revoke it.

Worse, `screenRequirement` never checks `maxTimeoutSeconds`, which is exactly the field
`@x402/evm` uses to compute `validBefore`. Proven: a 402 with `maxTimeoutSeconds: 10000000000`
yields a signed authorisation valid until **2343**.

No hostile server needed to exploit it: an agent doing name searches that miss gets a "free" 404
each time, and hands the payee a live USD 0.01 authorisation each time. 10,000 misses = USD 100 of
outstanding authorisations against a USD 1.00 cap, invisible to the ledger and to the tool
description.

Fix: account against signatures, not settlements — credit a release back only once `validBefore` has
passed, or track outstanding-authorisation exposure as a second cap. Clamp `maxTimeoutSeconds` in
`screenRequirement` (the live endpoint asks 300; refuse anything much above ~600).

### B2. The server being paid decides how much to debit the cap
`src/lookup.ts` commits `body.payment.price_usd`, and `src/ledger.ts` clamps only the UPPER side
(`actual > atomic ? atomic : actual`). There is no lower bound and no comparison against what was
actually signed. Proven: a body reporting `price_usd: 0` allowed **500 signed USD 0.01 payments**
with `ledger.spent = 0` and `chargedCallCount = 0`, so even the summary line reads clean.

This is squarely inside the threat model the comment block in `src/payment.ts` claims to defend.

Fix: debit `max(reportedPrice, signedAmount)`, or treat `price_usd` as display-only and always commit
the reservation.

### B3. A failed body read leaks the reservation permanently and bricks the server
`const bodyText = await response.text()` sits OUTSIDE the try/catch. If the body stream errors
(timeout between headers and body, `TypeError: terminated`, truncated response) neither `commit()`
nor `release()` runs. Proven: after 100 body-read failures, `reserved` = the whole cap, `spent` = 0,
and every later lookup fails with a cap message claiming nothing was spent — while the money for
those calls may well have moved.

Fix: try/finally around the body read and everything after it, with settle-once semantics.

### B4. A timeout after the payment was sent releases the reservation
`src/lookup.ts` releases on any throw, with a comment asserting "either no signature was produced,
or the request never reached the resource server". Both disjuncts are false for the abort case — and
`src/server.ts` then tells the model "Whether the payment settled is unknown", contradicting the
accounting.

Not exotic: one `AbortSignal.timeout` is shared by the unpaid attempt AND the paid retry, so the
budget covers 402 discovery + signing + facilitator settlement. Proven end to end.

Fix: record payload creation via the client's `onAfterPaymentCreation` hook and `commit()` rather
than `release()` when a throw follows a signature. Give the paid retry its own deadline.

### B5. `extra` is entirely unscreened, so the signing path can be moved off the audited one
The allowlist covers `scheme`, `network`, `asset`, `payTo` and price — nothing in `extra`.
`ExactEvmScheme` branches on `extra.assetTransferMethod === 'permit2'`. Proven: a server satisfying
every allowlist clause obtained a `PermitWitnessTransferFrom` to the x402 proxy instead of an
EIP-3009 transfer — a signature shape this project has not audited. `extra.paymentFlow: 'escrow'`
also signs, unscreened. Amount is still capped, so it is bounded per call, but for any wallet that
has ever approved Permit2 for USDC that signature is directly spendable, and combined with B1 an
unbounded number can be harvested.

Latent and currently unreachable but worth writing down: the same scheme's gas-sponsoring hook will
sign `approve(Permit2, MAX_UINT256)` — an unlimited USDC allowance — gated only on the signer having
`readContract`. It bails today *only* because `new ExactEvmScheme(signer)` is built with no scheme
options and a viem local account has no `readContract`. **Never pass RPC scheme options to that
constructor.**

Fix: allowlist `extra.assetTransferMethod` as `eip3009` or absent.

### B6. A paid result can be thrown away by output-schema validation
`src/lookup.ts` casts `body.results` to `Company[]` with no validation and `src/server.ts` hands it
straight to `structuredContent`. The SDK validates against the declared `outputSchema` and, on
failure, discards the whole result. Proven: `former_names: null` from the API produced
`isError: true`, no structured content, no spend summary — and `ledger.spent = 10000n`. Money gone,
model got nothing, and its obvious next move is to retry.

`companySchema.partial()` makes ten fields optional but `former_names` stays a required array, so
`null` fails where absent would pass.

Fix: validate or coerce each record before it becomes `structuredContent`, and on failure still
return the text plus the spend summary rather than losing a paid result.

## Should fix

- **`payTo` is not pinned.** Only checked as well-formed hex. The payee is known and the daily canary
  already asserts it has not moved, so it is pinnable. As written, a hijacked endpoint redirects
  every payment within the ceiling.
- **A charged 200 with zero results tells the model it was not charged.** `renderText` takes the
  `!found` branch and drops the cost line, so the text contradicts `structuredContent.charged: true`
  and reinforces "misses are free".
- **"Do not retry" after a `charged: "unknown"` is prose, not a control.** For a driver that is an
  LLM in a loop, that is not enforcement. A short latch refusing the identical query for
  `maxTimeoutSeconds` would make it real.
- **v1 price-field precedence is backwards.** `src/money.ts` reads `amount ?? maxAmountRequired`;
  `@x402/core` uses `x402Version === 1 ? maxAmountRequired : amount`, and the v1 scheme signs
  `maxAmountRequired`. Not exploitable today only because zod strips unknown keys off the v1 schema —
  an accident of a dependency, not a defence. `buildPolicy` already receives `x402Version` and
  discards it. `test/money.test.ts` currently locks the WRONG precedence in.
- **`Retry-After` is rendered with a literal `s` suffix**, which is wrong for the HTTP-date form.

## Test-quality findings worth acting on

The reviewer rebuilt `createPaidFetch` with the policy registration omitted and re-ran every attack
the suite asserts: **all five were still refused, all by `@x402/core`, and zero tests failed.** So
the suite currently proves the library, not this project's own screening. Named as tautological:

- `lookup.test.ts` "releases the reservation when the request never completes" — asserts B4 as a
  feature; its stub throws before any 402 exists so it cannot tell "threw before signing" from
  "threw after".
- `lookup.test.ts` "charges the price the response reports, once" — the mock reports an honest 0.01,
  so it passes whether the code trusts the server, commits the reservation, or hardcodes the value.
  It cannot fail on B2, the exact property its name claims.
- `ledger.test.ts` "never commits more than was reserved" — exercises the clamp only in the harmless
  direction. The dangerous direction is B2.
- `payment.test.ts` "accepts the v1 spelling" — the v1 fixture carries both fields at the same value,
  so it never exercises the fallback.
- `server.test.ts` "never puts the wallet key in a tool result" — only ever runs the happy path.

Untested failure modes: a throw after the payment header was sent; `response.text()` throwing; an
under-reported `price_usd`; a drifted record through a real `Client`; a 200 with `count: 0`; a large
`maxTimeoutSeconds` or a hostile `extra`; **the v1 signing path end to end** (the stub always serves
the v2 header, so `registerV1` is effectively dead code as far as the suite knows); `Retry-After` as
an HTTP-date; cumulative accounting across a mixed sequence of outcomes; shutdown with a payment in
flight.

## Clean

No private-key leak found, and the reviewer said so rather than padding: no `console.*` or
`process.stdout` in `src/`, diagnostics go to stderr including the fatal stack, a malformed key is
refused without echoing it, and viem/x402 errors carry no key material. Two cheap hardenings
suggested: bound what `renderError` passes through from library messages, and add
`console.log = console.error` in the entrypoint so the stdout invariant is structural rather than
dependent on no dependency ever logging.

Also verified clean: case handling on network and asset, the library cannot select an entry the
policy never saw, and the wrapper's double-sign branch is dead for this client so one tool call
cannot produce two payments.

## Fix order

1. B1 + the `maxTimeoutSeconds` clamp — this is the one that makes `SPEND_CAP_USD` mean something.
2. B2 — never let the server's reported price shrink the debit.
3. B3 — try/finally around the body read.
4. B4 — commit, do not release, when a throw follows a created payload.
5. B6 — validate records before they become `structuredContent`.
6. B5 + pin `payTo`.

Then rewrite the tautological tests above so each one can actually fail, and add an end-to-end v1
signing test.

---

# Resolution, 2026-09-09 (same day)

All six blockers and the "should fix" list are fixed on `main`. **Publish is still blocked** pending a
second independent review of these fixes. `npm test`: 133 passing, up from 88.

## What changed, by finding

**B1 — the ledger now accounts for signatures, not settlements.** `createPaidFetch` registers an
`onAfterPaymentCreation` hook, so every authorisation this process signs is reported to the ledger
*before* the paid request is sent, with the value and `validBefore` read out of the payload itself
rather than out of the 402. Attribution across concurrent tool calls is done with an
`AsyncLocalStorage` observer, since one paying fetch is shared by every call. `release()` no longer
means "free": the reservation comes back, but the signed amount is held as **outstanding exposure**
until its `validBefore` passes, and `remainingAtomic` subtracts it. Ten thousand misses against a USD
1.00 cap now stop at 100. `screenRequirement` refuses any `maxTimeoutSeconds` above
`MAX_AUTHORISATION_SECONDS` (default 600; the live endpoint asks 300).

**B2 — the payee can no longer choose what the cap is debited.** `commit()` clamps both sides:
never more than reserved, never less than what was signed. `price_usd: 0` against a USD 0.01
signature now debits USD 0.01. The 500-call proof stops at 100.

**B3 — `try/finally` around the body read and everything after it.** `settleDefault()` in the
`finally` charges if a signature exists and releases if none does, with settle-once semantics so an
explicit outcome always wins. A hundred failed body reads leave `reserved` at 0 and the server
still taking lookups.

**B4 — a throw after a signature exists commits.** The catch distinguishes "threw before signing"
(release, rethrow) from "threw after signing" (commit, and a `LookupError` with `charged: 'unknown'`
that says the money may have moved). The paid retry also gets its own deadline: the per-attempt
timeout moved into `createPaidFetch`, so 402 discovery can no longer eat the payment leg's budget.

**B5 — `extra` is screened and `payTo` is pinned.** `extra.assetTransferMethod` must be `eip3009` or
absent, and any `extra.paymentFlow` is refused, so the signing path cannot be moved onto Permit2 or
the escrow flow. `payTo` must equal `EXPECTED_PAY_TO` (default: the endpoint's published payee, which
the live canary asserts). `new ExactEvmScheme(signer)` is still built with no scheme options, with a
comment saying why.

**B6 — records are normalised, and the envelope is validated, before `structuredContent`.**
`normaliseCompany` coerces each record to the declared shape (`former_names: null` becomes `[]`)
while passing unknown keys through, and `toToolResult` validates the whole result against the same
zod object the SDK will use — on a mismatch it returns the paid text plus the spend summary rather
than an error with no data.

**Should-fix list.** v1/v2 price precedence now matches what `@x402/core` signs
(`x402Version === 1 ? maxAmountRequired : amount`), and `buildPolicy` threads the version through.
A charged 200 with zero results now prints its cost line. "Do not retry" became a control: a
`RetryLatch` refuses the identical query for `MAX_AUTHORISATION_SECONDS` after any unknown outcome.
`Retry-After` no longer gets a literal `s` on the HTTP-date form. `renderError` bounds what a
dependency message can put in a tool result, and the entrypoint aliases `console.log`/`info`/`debug`
to stderr so the stdout invariant is structural.

## One bug the new tests found

`registerV1('base', new ExactEvmScheme(signer))` could never sign anything. The v2 scheme class
derives its chain id from a CAIP-2 network and throws `Unsupported network format: base` on every v1
document. The v1 slot now takes `ExactEvmSchemeV1` from `@x402/evm/exact/v1/client`. The review was
right that `registerV1` was dead code as far as the suite knew — it was dead code full stop.

## Revert-fail evidence

Every fix was reverted in isolation and the suite re-run. The counts below are failing tests per
revert; the full list is in the vault note. Reproduce with the script recorded there.

| Revert | What was undone | Tests failing | First failure |
|---|---|---|---|
| `B1a` | release() gives back a signed authorisation as if it were free | 5 | SpendLedger holds a signed-then-released authorisation against the cap until it expires |
| `B1b` | maxTimeoutSeconds unscreened | 3 | screenRequirement refuses an authorisation that would stay spendable for longer than the ledger can account for |
| `B2` |  commit() trusts the price the payee reports | 3 | SpendLedger never commits more than was reserved, and never less than was signed |
| `B3` |  no try/finally around the body read | 2 | lookupCompany accounting, against a fetch that really signs settles the reservation when the body stream fails after the headers arrived |
| `B4` |  a throw after the payment was sent releases | 1 | lookupCompany accounting, against a fetch that really signs charges, and does not release, when the request throws after the payment was sent |
| `B5a` | extra unscreened | 4 | screenRequirement refuses an extra that moves the signature off the audited EIP-3009 shape |
| `B5b` | payTo not pinned | 3 | screenRequirement pays only the pinned payee, however well-formed the substitute is |
| `B6a` | records not normalised before structuredContent | 2 | the MCP surface returns a paid result the API drifted on rather than discarding it |
| `B6b` | structuredContent not validated against the declared schema | 2 | toToolResult keeps a paid result the SDK would have discarded, as text |
| `SF1` | v1/v2 price precedence collapsed to 'amount first' | 3 | atomicFromRequirement resolves a document carrying both fields the way the signer does |
| `SF2` | retry latch removed (advice instead of a control) | 2 | lookupCompany outcomes refuses the identical query after an unknown outcome, rather than advising against it |
| `SF3` | Retry-After always rendered with a literal 's' | 1 | lookupCompany outcomes releases the reservation on a rate limit and surfaces Retry-After in both forms |
| `SF4` | charged 200 with no records reported as not charged | 1 | the MCP surface says it was charged when a 200 comes back with no records |
| `SF5` | paid retry shares one deadline with 402 discovery | 1 | lookupCompany accounting, against a fetch that really signs gives the paid retry its own deadline instead of the leftovers of 402 discovery |
| `SF6` | v1 slot registered with the v2 scheme class | 1 | the v1 handshake, end to end pays a v1-only 402 with a signature that recovers to the configured wallet |
| `POL` | the project's own screening policy deleted entirely | 5 | the 402 handshake signs nothing when the endpoint asks to be paid at a different address |

The last row is the reviewer's own experiment: with this project's screening policy deleted, the old
suite failed **zero** tests because every attack was being refused by `@x402/core` rather than by
this code. It now fails five, all of them attacks `@x402/core` does not refuse — a redirected payee,
a centuries-long authorisation, a Permit2 steer, an escrow steer.

## Not done

- The `charged: "unknown"` latch is per process, so a restart clears it. Persisting it would mean
  writing state to disk, which this server deliberately does not do.
- Outstanding exposure is tracked in memory only, so a restart forgets authorisations that are still
  live. A cap is a per-process guarantee either way; the README does not claim otherwise.
