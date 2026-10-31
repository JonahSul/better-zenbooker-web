# Repository agent instructions

## Purpose and boundaries

This repository is a generic, single-business optional operations platform. Keep each feature independently optional, default-off where it can contact a provider or incur usage, and safe when its dependency or configuration is absent. Use the owner approval flow for publication. Never add anonymous first-owner claiming.

Before implementation, read `docs/EXTRACTION_PLAN.md`, `docs/MODULE_TEST_MAP.md`, `docs/ACCEPTANCE.md`, and the applicable feature section. The plan preserves every reusable module as real optional behavior; do not replace a module with an unused core or generic CRUD inventory. Preserve useful extracted domain regressions by adapting their fixtures to generic synthetic businesses, identities, and URLs; do not preserve source-branded marketing copy or production identifiers. Keep those unit/helper regressions clearly separate from new Worker HTTP/D1 runtime acceptance tests. Keep implementation mapping and test evidence current.

## Collaboration roles

- **Chat** rewrites user requests into clear implementation prompts and relays decisions and state changes.
- **Lead** coordinates work and dispatches Architect, Research, QA, and Dev.
- **Architect** owns plans and changes to approved scope, intervenes after repeated errors, and makes the completion declaration.
- **Research** returns scoped repository or web findings with citations.
- **QA** owns contract tests, documentation, and validation of developer deliverables.
- **Dev** owns runtime implementation, configuration, scripts, dependency manifests, and assets.

Respect file ownership assigned by Lead. Coordinate shared interfaces before writing against them. Escalate repeated errors through Lead to Architect; do not weaken checks to clear a gate.

## Architecture and security

- One installation serves one business and uses a dedicated D1 database.
- Provision the owner explicitly through trusted installation configuration. Do not grant owner status from the first anonymous request or a client-supplied identity.
- Recheck authorization, global AI state, per-feature AI state, module state, and configuration revision immediately before sensitive dispatch or mutation.
- A feature has explicit `disabled`, `unconfigured`, or `ready` state. Missing optional dependencies must not prevent core application startup.
- Current onboarding treats the supplied HTTPS source URL as provenance metadata only; users paste the text and no page fetch occurs. Reject private/non-HTTPS URL values and never trust URL metadata as authorization. If fetching is later added, first add bounded, redirect-safe SSRF protections.
- Use revision compare-and-swap for owner configuration and safe failure responses. Audit owner actions without recording secrets or unnecessary personal data.
- Keep external provider calls, booking, OTP email, notification, payment, and AI calls synthetic or injected in tests. Tests may submit synthetic inbound webhook bodies only to the loopback Worker. Never send a real booking, email/message, charge, webhook delivery, or paid inference as a test.
- Store real secrets only in the deployment secret store. Do not put real credentials in commits, fixtures, command output, logs, chat, or documentation. Tests may use clearly synthetic credentials only in ignored local fixture files; never commit those values, print them, or reuse them outside the disposable local fixture.

## Validation and evidence

QA tests the deployed local Worker over HTTP with isolated D1 state, using injected verification/provider seams where available. Do not call source-unit-test reuse a runtime acceptance test. Report local HTTP/D1, browser, provider, and hosted deployment evidence separately. If no supported browser or native acceptance capability is available, mark those checks unverified.

Use `docs/ACCEPTANCE.md` as the release checklist. Do not declare completion from a package/build pass alone. Keep the inventory in `docs/MODULE_TEST_MAP.md` aligned to real implementation paths and test files as they are added.

## Official tooling provenance

`docs/TOOLING_PROVENANCE.json` records the upstream Cloudflare skills source and reviewed commit used for Cloudflare-specific implementation guidance. `npm run setup:skills` installs only the pinned official references into `.agents/`; use it when the task needs those skills. These files are agent guidance, not application dependencies or runtime behavior. Do not fetch unpinned remote skill content.
