# Optional business operations platform

## Installation

> **Agent bootstrap prompt — read this first.** You are helping install or extend a single-business web platform. Start by reading `AGENTS.md`, then `docs/EXTRACTION_PLAN.md`, `docs/MODULE_TEST_MAP.md`, and `docs/ACCEPTANCE.md`. Before Cloudflare or Workers work, review `docs/TOOLING_PROVENANCE.json` and run the repository's pinned `npm run setup:skills` helper when the task needs those skills; do not install or connect Cloudflare account tools automatically. Keep optional features off until the owner explicitly configures and enables each one. Never enable paid AI, send messages, create a provider booking, or publish content as an installation test. Provision the first owner through the documented deployment/setup flow; never offer an anonymous “claim owner” path. Preserve secrets and real business data. Make changes only after explaining the intended behavior and its test boundary. Report separately what local HTTP/D1 tests prove and what still needs an owner, browser, provider, or Cloudflare verification.

## Deploy to Cloudflare

This project is designed for one business per Cloudflare Worker and D1 database. The Cloudflare button creates a deployment in **your** Cloudflare account. It does not connect this project to anyone else's provider accounts or authorize content publication.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FJonahSul%2Fbetter-zenbooker-web)

Cloudflare's Deploy button currently requires a public GitHub or GitLab repository. If this repository is private, use the manual setup below or deploy a public fork. Review the deployment configuration and provisioned resources before confirming. The button may set up Workers Builds for the repository Cloudflare creates; review and disable automatic production deployment if that does not fit your release process. See [Cloudflare Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

The button does not provision the first owner or Google OAuth credentials. Before signing in or opening `/setup/business`, set the installation variables and secrets in the Worker's Cloudflare settings as described in manual setup step 4, then deploy a new Worker version. No anonymous owner-claim path exists.

## Manual setup

1. Fork or clone the repository, create a Cloudflare account, and install the Node.js version declared in `package.json`.
2. Run `npm ci`. If Cloudflare-specific agent guidance is needed, run the repository's pinned `npm run setup:skills` helper. Then run `npm run check`, `npm run build`, and `npm run db:migrate` against local D1. These local checks do not contact a business provider.
3. Create a dedicated D1 database for this installation and configure the Worker's `DB` binding in `wrangler.jsonc`. The binding name must remain `DB`. Apply checked-in Drizzle migrations through the deployment helper for remote D1; `npm run db:migrate` applies them only to local D1. Never create schema in request handlers.
4. Before the first owner sign-in, configure the required installation settings:
   - Non-secret Worker variables: `INSTALLATION_ID` (a stable unique value), `PUBLIC_ORIGIN` (the final HTTPS origin), and `OWNER_EMAILS` (comma-separated exact Google account email addresses allowed to administer this installation).
   - Google OAuth client: provision an OAuth web client and set `ADMIN_GOOGLE_CLIENT_ID` as a Worker variable and `ADMIN_GOOGLE_CLIENT_SECRET` as a Worker secret. Add the exact authorized redirect URI `<PUBLIC_ORIGIN>/api/admin/auth/callback` in Google Cloud. The installer must explicitly put the first owner's verified Google email in `OWNER_EMAILS`; there is no anonymous first-user claim.
   - Encryption secret: generate a fresh 32-byte base64 value for `APP_CREDENTIAL_ENCRYPTION_KEY` (for example, run `node -p "require('node:crypto').randomBytes(32).toString('base64')"` locally) and save it as a Worker secret. Keep the output private and back it up using your secret-management process. It is used to protect credentials and private integration data in D1.
5. Authenticate Wrangler to the intended Cloudflare account, review `wrangler.jsonc` and the migration target, then run `npm run deploy` as an explicit operator action. It builds the Vinext Worker, applies migrations to the configured remote D1 database, and deploys the compiled Worker. Confirm the account, database, and target before running it; deployment does not provision business-provider connections or authorize content publication.
6. Sign in with the pre-provisioned owner account, then open `/setup/business`. Enter business details and, if useful, paste source text with its HTTPS URL for provenance. The current setup does not fetch that URL. The initial site is a deterministic source-backed draft. Review it and use the owner approval action to publish. Publication makes approved content publicly viewable but does not enable search indexing: public pages and discovery responses remain `noindex` by default. No SEO or indexing capability is implied.
7. Leave all optional integrations disabled until they are independently configured and explicitly enabled. Optional AI, scheduling, messaging/email, analytics, experiments, photo/vector storage, and other providers are not required for installation. Do not paste credentials into chat, source files, examples, or logs.

### Local Worker checks

For the integration suite, use only synthetic values in the ignored `.dev.vars` file and a disposable local D1 store. The following PowerShell commands build and run the compiled Worker locally; the integration suite runs in a second terminal:

```powershell
npm run build
npm run db:migrate -- --persist-to .wrangler/qa-disposable-d1
$envFile = (Resolve-Path .dev.vars).Path
npm run start -- --local --ip 127.0.0.1 --port 5178 --compatibility-date 2026-05-22 --persist-to .wrangler/qa-disposable-d1 --env-file $envFile
```

Then run `npm run test:integration` from another terminal. Wrangler loads env files relative to the compiled config under `dist/server`, so `--env-file` must receive the **absolute path** to the repository-root `.dev.vars` file; do not copy secrets into `dist/`. The runner checks that its D1 path is exactly `.wrangler/qa-disposable-d1` and seeds only synthetic local records. The compatibility override is for local tooling only; production configuration remains on the pinned date. These tests do not exercise a browser or a deployed Worker.

`npm test` discovers and runs every `tests/*.test.mjs` file. Fixture-specific integration checks skip unless their documented local-fixture variables are set. To include the separate empty-database, no-provider smoke check in `npm run test:integration`, set `QA_BASE_WORKER_BASE_URL` to a second fresh loopback Worker fixture; the test rejects non-loopback URLs and does not send provider credentials or business requests.

### Optional Codex and Cloudflare account tooling

The repository's `npm run setup:skills` helper downloads the official Cloudflare Skills archive at the exact commit recorded in `docs/TOOLING_PROVENANCE.json`, verifies archive paths, and installs the selected official skill references. It does not install a Cloudflare account connection. Developers who manage their own Codex tool setup may follow the [pinned official Cloudflare Skills README](https://github.com/cloudflare/skills/blob/1a33048817d06df12882cb881dfc754e7039954a/README.md) and run:

```sh
codex plugin marketplace add cloudflare/skills
codex plugin add cloudflare@cloudflare
```

These commands configure optional developer guidance only; they do not connect an account. Skill files are not application dependencies.

The Cloudflare account MCP endpoint is `https://mcp.cloudflare.com/mcp` and uses an OAuth account connection. It is distinct from the optional authenticated MCP endpoint implemented by this application. Connecting account tooling grants that tool access according to Cloudflare's consent screen; do not connect or authorize it as an automated project setup step. See the [official Cloudflare MCP documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare-mcp-server/).

### AI and provider configuration

AI is globally off by default; each AI-backed feature also has an independent server-side gate. Keep both off unless the owner deliberately enables a feature after reviewing its provider, data flow, budget, and privacy implications. When enabled, Workers AI is the first provider. No paid AI account is required to install or run core public pages, admin configuration, contact/date requests, or local analytics.

Optional provider credentials are not part of the required installation form. Configure them only for the feature that needs them, using the hosting provider's secret store. A feature without credentials reports `unconfigured`; an explicitly disabled feature reports `disabled`; only a configured and enabled feature reports `ready`. Disabled or unconfigured features must not make outbound calls.

Analytics snapshot imports also require an installer-controlled Worker variable named `ANALYTICS_IMPORT_BINDINGS`. Set it only when intentionally connecting imported analytics data. Its value is a JSON array (up to 16 entries) of exact trusted bindings, for example `[{"projectId":123,"source":"ga4","resource":"properties/456","scope":"ga4_property"}]`; Search Console entries use `source:"search_console"`, a verified HTTPS site URL or `sc-domain:example.com`, and `scope:"production_search"`. Replace the example identifiers with resources actually authorized for this installation. The importing request cannot add or widen its own bindings; absent, malformed, or nonmatching configuration is rejected. No provider property or project is preconfigured by this repository.

## What this project provides

The platform retains optional implementations for public theme and service offerings, owner administration and audit, hosted scheduling and historical booking operations, contact/date requests and notifications, Google customer/review integrations, consent and measurement, experiments and cached page compilation, visitor help/preferences/feedback/photo assistance, admin chat and memory, analytics/AI/background jobs, and an optional authenticated MCP interface. See [the module-to-test map](docs/MODULE_TEST_MAP.md) for the implementation and evidence inventory. These are optional components; installation does not imply that any provider is connected or any feature is enabled.

## Evidence and limitations

Use [the acceptance checklist](docs/ACCEPTANCE.md) to distinguish HTTP/D1 test results from browser, provider, and native deployment results. A passing build or local test does not establish browser appearance, real provider connectivity, successful delivery, or deployed behavior. The checklist records outstanding verification explicitly.

## License

See [LICENSE](LICENSE).
