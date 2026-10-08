# Platform-owned COIN transfers

This module is the platform half of third-party App transfers with two-ledger
reconciliation. It keeps `gp_wallet_bindings.provider=platform`; it does not turn
the third party into the game's wallet or add an administrator money faucet.

## Activation boundary

The shipped server registers **no real transfer adapters**. Every new binding
defaults to `disabled`, every account link defaults to inactive, and the migration
grants no capabilities or funds. Even a valid ordinary App HMAC and manually
enabled binding cannot transfer money without a separately reviewed code adapter.
No HTTP route provisions a binding, approves an account link or edits a balance.

Before an actual partner can be enabled, its operator-approved binding must pin
the issuer/merchant, immutable adapter protocol/configuration version, exact
endpoint/credential references and explicit App key capabilities. Account links
must prove third-party account ownership and user authorization, not trust an
arbitrary browser-supplied name. `verified_by` and `proof` represent the approved
onboarding evidence; a nonempty JSON object alone is not an account-verification
protocol. Only trusted onboarding may populate these rows. The onboarding UI and
actual partner network adapter are not implemented by this slice.

The partner's debit/credit/query/statement endpoints, receipt proof, idempotency
retention/cancellation guarantee, COIN conversion/fees and return-of-winnings
policy remain unconfigured. No synthetic adapter or invented callback confirmation
is loaded by the server. Production game admission/math approval is unchanged.

## Platform API

All routes use the existing exact-path partner HMAC/nonce/rate-limit middleware,
then independently check an active key's financial capabilities under its own
binding and App. Credentials and mapping identifiers are never accepted as scope
overrides. Production platform-wallet scope must match the persisted App.

`POST /v1/transfers` accepts exactly:

```json
{"request_id":"partner_original_id","account_id":"verified_mapping_id","direction":"IN","amount_minor":"100","currency_id":"COIN"}
```

`direction` is `IN` or `OUT`; amount is a positive canonical integer string no
larger than signed int64. Header request ID must match. `IN`/`OUT` capability is
required. Admission also requires active App/binding/account and a registered
adapter. Every valid admitted intent is committed with its owned hold, original
bytes, outbox and audit before returning. Response is `202` for PENDING, `200` for
a replayed terminal operation. Reusing the original request ID with different
bytes fails with `IDEMPOTENCY_CONFLICT`. Pre-admission validation, authority or
insufficient-funds errors do not create a transfer or dispatch an external request.

`GET /v1/transfers/:id` requires `READ` on that App's binding. It returns the
original intent and safe status/receipt; it never dispatches or implicitly retries
money. It remains available during new-admission pause when the read grant remains.

`GET /v1/transfer-ledger/:binding/:after/:through` requires `RECONCILE`. `after` is
an exclusive decimal ledger row ID; `through` is `latest` or a previous returned
inclusive high watermark. At most 100 rows are returned. Follow `next` with the
same `through` until a page is empty; request `latest` for a later increment.
This path form preserves existing HMAC canonicalization; query strings are not a
second unsigned source of pagination parameters.

Each row contains request ID, transfer ID, external operation ID, binding/mapping
references, direction/amount/currency, immutable local ledger row/transaction,
balance deltas, and state at that entry. Terminal rows additionally contain the
external transaction ID (success only) and immutable final receipt. A prior hold
row stays PENDING with no final receipt even after the transfer settles; only its
later finalization rows carry terminal evidence. Thus pagination at an old high
watermark cannot silently include future receipt/state data.

Inbound capacity reservation and its explicit rejection produce zero-amount
ledger events with `credit_pending_delta` metadata. They change no spendable
balance but preserve a versioned, append-only statement of both pending and
rejected inbound attempts. Every ledger row still increments `ledger_version`;
the sum of each transaction's financial deltas remains zero.

## Financial and recovery contract

### Read-only console operations

The existing administrator and partner consoles expose **资金划转查询** within
**局单与对账**, including an App selector, exact original-request search, status
filter, bounded next-page navigation, and original-order details. This is a
read-only operational view, not a way to retry, refund, unfreeze, adjust a balance
or force a successful result.

`GET /api/admin/transfers` and `GET /api/partner/transfers` use their existing
separate console cookies. Only `platform_admin` or the authenticated
`partner_developer` on its respective route is accepted. There is currently no
separate organization-level `financial-read` scope; this view follows the same
two-role authority as existing console financial records. It grants no App-key
financial capability. An ordinary App HMAC is not console authentication.

Allowed query parameters are `app_id`, `state` (`PENDING`, `SUCCEEDED`, or
`REJECTED`), exact `request_id`, `limit` (1–100, default 25), and `cursor`. Unknown,
duplicate, oversized, and malformed parameters are rejected. SQL constrains the
runtime environment and, for partners, the authenticated partner ID before
pagination or projection. An explicit foreign or nonexistent App or original
order returns the same 404. Query parameters cannot supply an alternative tenant
or environment. Detail is `GET .../transfers/:transfer_id`, with only optional
`app_id` accepted; non-GET methods are rejected.

Each request uses a bounded repeatable-read, read-only database transaction.
Pagination uses `(created_at, id)` with full PostgreSQL microsecond precision and
an explicit C collation. The cursor retains the initial highest visible tuple
and binds the console principal, environment and filters. It is an opaque
continuation, **not an authorization token or a frozen multi-request snapshot**.
Later orders above that upper bound are excluded; an earlier transaction that
commits later may become visible below it. Order status can also change between
pages, especially when filtering PENDING. Refresh from the first page for a new
view. No offset, client-selected sorting or unbounded export is supported here.

Responses allowlist original request/transfer identifiers, App, direction,
integer minor-unit amount/currency/scale, timestamps and age, persisted attempt
count and next-attempt time, lease-derived scheduling state, fixed error
categories, and last recorded external state. Detail includes safe original
operation/transaction/ledger references and selected terminal receipt fields.
No binding configuration, credential reference, account proof, partner account,
raw request/provider body, lease token or arbitrary provider error is returned.
Unknown stored observations are reported as unknown instead of echoed.

`status_basis=stored_order_not_reconciled` is explicit: the displayed hold and
local credit/debit state are **derived from the order**, not a fresh independent
wallet/ledger audit. An unresolved OUT records reserved funds; an unresolved IN
records reserved credit capacity. Both stay unresolved through backoff or an
unknown external outcome. Current App/binding admission status and account
mapping activation are shown separately and do not imply that an accepted old
order has stopped recovery. The GET paths never invoke an adapter, recovery,
ledger write or external business request. Responses are `Cache-Control:
no-store`.

- `IN`: reserve destination credit capacity before sending the external debit.
  Verified SUCCEEDED debits permit one atomic user credit, owned capacity release,
  signed clearing counter-entry, receipt and audit. Definitive REJECTED releases
  capacity without a credit.
- `OUT`: reserve only available coins under the same advisory lock as game spending.
  Verified external credit SUCCEEDED consumes that reservation and posts the
  clearing counter-entry. Definitive REJECTED releases only that transfer's hold.
- Business states are monotonic `PENDING → SUCCEEDED | REJECTED`. QUEUED,
  NOT_FOUND, TRANSFER_UNKNOWN, receipt-invalid and duplicate-external-transaction
  observations are not financial terminal states. An unknown outbound holds its
  funds indefinitely until authoritative reconciliation; no age-based refund.
- The outbox persists original normalized bytes/ID/hash before dispatch. Attempts,
  next attempt and a 30-second claim lease are durable. Recovery queries the original
  order after any prior attempt; only authoritative NOT_FOUND permits replaying the
  same idempotent operation. PENDING causes query/backoff, not a fresh debit.
- External transaction IDs are unique across key rotation and Apps for the same
  issuer/merchant/environment. An already credited debit under a new request ID
  remains unresolved rather than crediting twice or pretending rejection.
- The factory allows at most four active operations and four actual adapter calls;
  an abort-ignoring adapter keeps its physical slot until it settles. Default call
  timeout is 3 seconds. Recovery scans at most ten due orders per invocation and
  uses persisted exponential backoff capped at five minutes. Timers never create
  new business IDs. Shutdown stops admission and waits for core work; its return
  reports any adapter call that ignored cancellation, never claims it was stopped.
- New-admission pause does not erase accepted obligations. Recovery uses the
  original immutable mapping and binding identity; destination/config drift blocks
  it and preserves funds. Disabled admission alone does not prevent original-order
  query/finalization. Finalization and its audit are one database transaction.

This is not a distributed atomic transaction. It is an atomic local ledger plus
durable cross-system intent, idempotent authoritative query and reconciliation.

## Internal adapter interface

`createTransferService({pool, adapters, environment, timeoutMs})` exposes
`create`, `read`, `advance`, `recoverPending`, `statement`, `state` and `close`.
`adapters` is a trusted code registry, not dynamic code or an endpoint supplied by
an HTTP caller. Every adapter must declare `idempotentReplay: true` and
`authoritativeQuery: true`, implement synchronous `validateBinding(binding)`, and
implement `submit(handle,{signal})` / `query(handle,{signal})`.

The deeply immutable handle has the pinned binding, original normalized operation,
its raw bytes and SHA. The adapter maps the **actual agreed partner protocol** into
an exact normalized result: original operation/scope/issuer/merchant/account/
direction/amount/currency/scale, original body SHA, state, successful transaction
ID or definitive rejection (`final:true`, `rejection_code`). It must derive those
facts from authenticated authoritative evidence; merely copying request fields
onto an unrelated response is not validation. No requirement in this internal
normal form is a claim that an unknown partner already offers that wire format.

Neither HTTP status 200 nor 404 alone confirms a money outcome. Timeout, body loss,
unparseable data, wrong identity/amount/hash and unproven rejection retain PENDING.
An adapter must enforce reviewed HTTPS/origin/DNS/signing/size controls and abort
semantics. The current external game-wallet transport offers reusable primitives,
but is not silently repurposed or enabled here.

## Schema, audit and restore

Five additive tables hold binding, verified mapping, transfer, outbox and signed
clearing projection. `server/transfers/audit.mjs` exposes a strict complete/absent
schema check, transfer audit and pending obligations. Partial schema, views in place
of tables, or missing transfer tables with transfer ledger evidence fail closed.
Clearing is projected into ledger audits, never exempted as test funding.

The audit reconstructs all user reserved/credit-pending amounts from game
reservations, probability liabilities, captured matches and pending transfers. It
also compares clearing to both ledger rows and successful transfers, checks stored
request/outbox hashes and terminal receipt relationships. Pending is preserved in
backups and restoration; it is not corrupt merely because it remains unresolved.
Deployment admission and rollback must count every PENDING observation as an
obligation, and schema/audit read failures remain failures.

`deploy/restore-drill.mjs`, `deploy/monitor.mjs` and `deploy/activate-release.py`
consume these interfaces in the same repeatable-read, read-only snapshot as their
other database checks. Restoration includes all five tables and the clearing
projection; it reports pending obligations without settling them. Monitoring
measures unresolved age from original creation, including backoff and unknown
results. Activation checks pending transfers before the switch and again before
automatic rollback. A genuine legacy database is accepted only when all five
tables and any transfer ledger evidence are absent; partial schema is an error.

Dedicated tests use random owned loopback PostgreSQL databases, a synthetic adapter,
actual HMAC HTTP guards, and actual pg_dump/restore. They are not real partner
settlement, live credentials, public deployment or production acceptance evidence.
