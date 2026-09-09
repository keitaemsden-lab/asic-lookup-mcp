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
