# Acceptance checklist

This is the QA contract for the extraction. Items remain **planned** until evidence from this repository is recorded. Do not interpret the source application's prior tests or status as evidence for this destination.

## Installation and optionality

- [x] A fresh built Worker/D1 fixture starts with provider credentials and AI binding absent; `/`, `/api/site`, and unauthenticated `/setup/business` return without server errors, the site is unpublished, offerings are empty, and all optional capabilities report not ready.
- [ ] Core public routes, owner setup/configuration, and contact/date intake remain usable without optional integrations.
- [ ] Every optional feature reports one of `disabled`, `unconfigured`, or `ready`; missing configuration is never silently simulated as ready.
- [ ] Feature disablement does not break unrelated modules.
- [ ] Every claimed retained module has a reachable UI/route, concrete enabled operation, and an enabled-path HTTP/D1 test. Generic CRUD, metadata-only inventory, unused copied cores, and default-off-only tests do not count as implementations.
- [x] Synthetic unit/Worker checks prove global AI off and per-feature AI gates reject immediate and scheduled work before Workers AI or injected provider calls; call counters stay at zero. Configured enabled AI remains unverified.
- [ ] Workers AI is selected before any optional paid provider; no paid AI account is an install prerequisite.

## Identity, configuration, and data boundaries

- [x] No anonymous first-owner claim exists. Owner route tests require the installer-allowlisted verified Google administrator; browser/customer identity is not owner authority.
- [ ] Sessions are secure, HttpOnly, appropriately scoped, and mutation CSRF/origin checks are enforced.
- [ ] Admin credentials and provider secrets are never returned in clear text, written to logs, or included in ordinary application exports.
- [ ] Owner configuration mutations use revision compare-and-swap; stale writes conflict and do not partially mutate or create misleading audit records.
- [ ] Owner mutations create useful audit records with sensitive values redacted.
- [ ] A Worker installation is bound to its own stable installation identifier and D1 database; cross-installation records are inaccessible.
- [ ] D1 schema is created only through versioned migrations; request routes never create or mutate schema.
- [x] Request bodies, strings, collections, redirects, and selected provider inputs have finite bounds; Worker tests reject hostile JSON before dispatch, and errors are safe. Import URL validation and every provider timeout are not comprehensively covered by HTTP/D1 tests.

## Import and publication safety

- [ ] In current onboarding, a source URL is provenance metadata only; the user manually pastes any text and the app makes zero outbound requests. Reject non-HTTPS, private, loopback, link-local, and reserved URL values.
- [ ] If a later approved version adds retrieval, it validates DNS/address destinations, limits/revalidates redirects, and bounds response body and time. Imported text remains untrusted and cannot set business identity, credentials, publish state, or authorization.
- [ ] Manual details or import results create a source-backed draft. Publication requires a current owner approval and matching revision.
- [ ] An approval against stale draft/configuration is rejected. Failed publication leaves the prior published version intact.
- [ ] Public pages expose only approved content; administrative/private routes are noindex and never appear in public discovery output.

## Optional operations and zero-side-effect tests

- [ ] Disabled or unconfigured Zenbooker, Google, messaging/email, analytics-export, image/vector, and other provider features make zero outbound calls.
- [ ] Tests use synthetic isolated D1 state and injected fetch/provider seams. No test sends booking, OTP, webhook, email/message, payment, charge, or paid inference traffic.
- [ ] Contact/date requests remain requests, not confirmed appointments or provider jobs.
- [ ] Historical booking operations, if retained, require exact current provider context, idempotency, revision checks, and authorization; ambiguous writes remain unknown and are never blindly retried.
- [ ] Consent is purpose-specific. A grant for one purpose cannot enable another. Withdrawal blocks future dispatch.
- [ ] Admin chat shares the protected admin authorization boundary, calls a typed allowlist only, keeps per-admin interaction memory private, and applies shared curation only within the installation.
- [ ] Memory deletion/undo and vector lifecycle are D1-authoritative; deleted content cannot re-enter model context.
- [ ] MCP is optional, separately authenticated, and restricted to the same typed operation policy; it cannot bypass admin authorization.

## Local runtime evidence

Current local evidence is deliberately partial. On 2026-10-31 the following were verified against the target checkout:

- [x] The rendered homepage returns HTTP 200 in the local Worker fixture.
- [x] An unconfigured booking route returns 503 with `private, no-store`, `nosniff`, and `noindex` headers.
- [x] An allowlisted synthetic local owner session can save a pasted-text business draft, publish the matching revision, and read the published text on the homepage. A stale draft write or publish returns 409; malformed publish input returns 400.
- [x] An owner can enable the real D1-backed private-memory module, create/read/tombstone an interaction memory through the protected admin tool route, and disable the module; a subsequent memory operation is denied. A stale module-config write returns 409.
- [x] A disabled hosted callback returns 503 with `Retry-After` and does not acknowledge the sample event.
- [x] Forged legacy runtime identity headers do not authorize `/api/admin/site`.
- [x] Encoded slash/backslash `return_to` cases remain on the local origin.
- [x] Worker JSON depth/fanout bounds reject nested or oversized collections, including mixed-case JSON media type, before route dispatch.
- [x] Scheduler unit contracts cover default-off cleanup with zero model dispatch, exact daily UTC schedule matching, stale/future time rejection, a final gate recheck, unpublished result, and stable daily request keys.
- [x] Customer OTP tests deny dispatch when either booking or notifications is off, create no challenge and make zero email calls; logout, export, and local erase remain available without either module.
- [x] Contact notification tests keep intake durable while notifications are off and prove no sender check, outbox inspection, or send is dispatched by the notification service.
- [x] Vectorize adapter tests reject index info/progress, get/query, and upsert with the module disabled before any fetch; explicit tombstone deletion cleanup remains available.
- [x] Global AI off and the visitor-support feature gate each reject text generation, embedding, and chat dispatch before either the Workers AI binding or injected provider fetch runs; all call counters remain zero.
- [x] An enabled synthetic local hosted-bridge test initializes encrypted credentials in local D1, rejects a wrong callback capability, captures and deduplicates an event, rejects a mismatched rotation receipt, rotates credentials, rejects the old capability, and accepts the new one.
- [x] A synthetic MCP machine with one explicit tool scope sees only that tool; a valid out-of-scope write is rejected, an in-scope write creates a pending owner receipt without execution, and the machine bearer cannot access browser owner confirmation.
- [x] The rebuilt Worker permits camera only on approved public HTML GET/HEAD routes and denies it on API/mutation/error responses; private/admin responses are `noindex`/`no-store`.
- [x] The fresh no-provider fixture returns core home/API and setup/login responses without a 5xx or redirect loop; the setup redirect stays same-origin and every optional module is unready.
- [x] The final local D1 fixture applied the full checked-in migration set (35 migrations) before acceptance.

Commands:

```powershell
npm test
$env:QA_WORKER_BASE_URL = 'http://127.0.0.1:5178'
$env:QA_BASE_WORKER_BASE_URL = 'http://127.0.0.1:5179'
$env:QA_DISPOSABLE_D1_PATH = (Join-Path (Get-Location) '.wrangler/qa-disposable-d1')
npm run test:integration
```

The dedicated integration command requires the Root-owned loopback fixtures, synthetic `.dev.vars` only for the main fixture, and the exact disposable main D1 path above. The base fixture uses a separate fresh D1 and an empty environment file. The runner rejects non-loopback URLs, seeds only synthetic records, and serializes tests that share the main D1. On 2026-10-31 the final rebuilt Worker integration run passed 11/11 checks: 10 HTTP/D1/MCP/bridge checks on the main fixture and one no-provider smoke check on the empty base fixture. The full `npm test` suite passed 733 tests (661 pass, 72 skipped, zero failures). All provider calls use local or injected test doubles; no external provider is contacted. This is local HTTP/D1 and adapter evidence only. It does not establish external booking or message delivery, provider connectivity, a real Cloudflare deployment, browser behavior, or native acceptance. Experiments/cache, photos, visitor-support threads, customer Google, actual webhook job promotion/pull/ack, and durable scheduler deduplication remain unverified. The remaining checklist below and `docs/MODULE_TEST_MAP.md` continue to apply.

- [x] Final built Worker fixture run confirms the public-document camera policy, denied camera permissions on API/mutation responses, and noindex/private headers.

- [x] Fresh isolated D1 migration run succeeds through all 35 checked-in migrations; no remote migration was run.
- [ ] First-run UI, adapted tests, and generic defaults contain no original business identity, contact data, branding asset, service area, timezone, seasonal schedule, or vertical-specific factual claim. Services, areas, business facts, and date timezone are owner-configured.
- [ ] Worker HTTP tests cover public, contact, auth, admin, config CAS, draft/import, publish, consent, and each optional module's enabled/disabled/unconfigured behavior.
- [ ] Tests inspect resulting D1 state and injected outbound-call counts, not only response bodies.
- [x] Supported package build and Wrangler dry-run succeed for the final artifact. No upload/deployment was performed.
- [x] `docs/MODULE_TEST_MAP.md` records each retained implementation family, concrete runtime paths and tests, exact current suite counts, and evidence limits.

## Human verification not represented by local tests

No approved browser capability or native Cloudflare acceptance has been established for this extraction. Mark these **unverified** until they are deliberately performed and read back:

- [ ] Browser: public rendering, keyboard navigation, responsive layouts, contact/date submission UX, owner sign-in, admin operations, draft review/approval, and disabled-feature status.
- [ ] Cloudflare: correct Worker and dedicated D1 bindings, applied migration status, secret configuration, owner allowlist, and deployment version/SHA.
- [ ] Hosted behavior: verify the public URL, noindex/private admin behavior, D1 persistence across reloads, and rollback/publication behavior against the exact deployed version.
- [ ] Provider readiness: only after owner configuration, verify OAuth/provider connection and read-only diagnostics. Separately record consent and any actual delivery/booking if explicitly authorized.
- [ ] AI readiness: confirm model calls remain zero with gates off; enable only with owner approval and verify the selected Workers AI binding and cost boundary before any real inference.

A package/build or HTTP/D1 pass does not close browser, provider, or native items. Keep these levels separate in release notes.
