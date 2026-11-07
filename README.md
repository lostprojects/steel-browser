# Toolstack

Toolstack manages people's skills and tooling as owned content, with private
account connections. Connecting through an agent provides the person's own
content plus packages explicitly assigned to them or shared with their organization.
Browser automation is its first execution toolkit.

The target is a multi-tenant subscription product, with private member workspaces
and strict boundaries between organizations. Today there is one real organization
and its owner; organization records and tenant isolation remain implementation
work. `global` is the existing sharing identifier and must become organization-wide.
See the [organization contract](ORGANIZATIONS.md) and
[delivery sequence](TOOLSTACK-PLAN.md#organization-delivery) before expanding access.

The application provides Library, Toolkits, Connections, Activity and Browser views.
Tool schemas drive the run forms; the UI and MCP use one catalog and executor.
API connections support registered providers, account verification and reversible
access controls. Exa search and explicitly installed owner content use the same
vault-backed connections, bounded usage and private execution history. The Muse
methods and media tooling are optional personal packages. The persistent Library
provides instruction import/editing, supporting files, publication and assignment
controls, with version history and authenticated downloads.
See [the search toolkit](SEARCH.md) for its implemented contract. Product direction,
rollout status and acceptance requirements live in [the Toolstack plan](TOOLSTACK-PLAN.md).

Mosaic's remote browser service runs on Railway with a configurable pool of independent browsers. Agent mode supports instrumented browsing; quiet mode uses a Linux display and native input for sites that resist automation.

Named profiles preserve login state on a volume. The service owns residential proxy allocations and an encrypted login vault; callers use named API keys with daily byte budgets.

This is a fork of [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser). The root guides describe this implementation; Git history retains the former upstream documentation.

The existing team-mode code adds one HTTPS gateway, personal agent keys and a
dedicated browser worker and volume per user within a single organization.
Its shared store supplies explicitly granted credentials and defaults; activity
stays private to each person. The organization design extends that model with
independent organization data services and storage, and private workers per membership.

See [private team browsers](TEAM.md) for provisioning, connection and the privacy boundary. Named keys on the standalone service do not provide this isolation.

## Connect to Toolstack

Open the hosted `/connect` page and copy its connection address into your
agent's remote MCP connections. Toolstack opens a browser approval page; supported
MCP apps manage their own access tokens. No local runtime or package installation
is required. Account access uses the existing invitation or browser sign-in.

Open a file's download link, or use **Downloads** in the dashboard, to save it
with your browser's normal controls on macOS or Windows. A ready handoff remains
available until thirty minutes after publication, even if its remote browser closes.

Check [the hosted rollout status](TOOLSTACK-PLAN.md#current-baseline) before using
OAuth or browser handoffs on a deployed endpoint.
The [optional automation client](client/README.md) provides automatic verified
local saves for scripts and agents that need that capability.

## Status and evidence

Phases 0–3 passed their acceptance checks on Google Chrome 156.0.8078.79. Managed routing, vault login and the MCP interface are implemented. Detailed measurements, including failed and interrupted attempts, remain in [STEALTH.md](STEALTH.md).

Mary Ferrell passed logout/re-login, retained-login and authenticated PDF checks on 5 November 2026. The known Ancestry profile passed authenticated reads on Ancestry, Newspapers.com and Fold3 after deployments and a Chrome crash. Its daily observation window runs from 5–12 November; the three-hour Fold3 viewer check remains incomplete.

Anna's Archive passed its later 20-search direct-browser acceptance. Bizapedia's final set was limited by the site's free quota and missed the bandwidth target. HathiTrust's single Google login attempt failed; its persistent attempt limit remains in force.

Twenty-one callers have verified first payloads. DTIC and HathiTrust lack qualifying remote runs. Browserbase remains available; exact windows and source blockers are in [mosaic/CALLERS.md](mosaic/CALLERS.md). Retirement requirements are in [the plan](TOOLSTACK-PLAN.md#caller-review-and-browserbase-retirement).

## Guides

| Read | For |
| --- | --- |
| [TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md) | Product direction, delivery sequence and acceptance requirements |
| [ORGANIZATIONS.md](ORGANIZATIONS.md) | Planned tenant boundaries, membership, sharing, administration and subscription model |
| [USAGE.md](USAGE.md) | API authentication, sessions, downloads and MCP tools |
| [LIBRARY.md](LIBRARY.md) | Owned skills, files, sharing, version history and storage |
| [TOOLKITS.md](TOOLKITS.md) | Tool discovery, generic execution and server-side extensions |
| [SEARCH.md](SEARCH.md) | Native API connections, search tools and recorded verification |
| [Local client](client/README.md) | macOS, Windows and Linux downloads, CLI and local MCP setup |
| [TEAM.md](TEAM.md) | Current single-org team code, private workers and the planned membership migration |
| [COMMANDS.md](COMMANDS.md) | Browser commands, snapshots, targets and execution results |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Railway configuration, persistent state and deployment procedure |
| [DESIGN.md](DESIGN.md) | Implemented component responsibilities and behavior |
| [FORK.md](FORK.md) | Differences from upstream and maintenance rules |
| [STEALTH.md](STEALTH.md) | Measured results and the measurement client |

## Local development

For the full Linux runtime, set `STEEL_API_KEY` in your shell and run `docker compose up --build`. Compose builds the root Dockerfile and keeps named profiles in a local volume. Open `http://localhost:3000/ui/?apiKey=<key>` once to set the dashboard's HttpOnly cookie.

For source development, copy `api/.env.example` to `api/.env`, set a local key and install Google Chrome. Create a Python environment with `python3 -m venv api/.venv`, then run `api/.venv/bin/pip install curl_cffi==0.16.3` and set `FETCH_PYTHON` in `api/.env` to that environment's absolute Python path. PDF downloads, routing reads and residential exit checks use this helper.

Run `npm ci` followed by `npm run dev`. The API listens on port 3000; open `http://localhost:5173/ui/?apiKey=<key>` for the dashboard.

Keep `DOMAIN=localhost:5173` in the source-development API configuration. Vite forwards API and WebSocket traffic on that origin; authentication redirects remove the key from the URL. Both development servers bind to loopback. Quiet mode requires the Linux X11 tools supplied by Docker.

Build with `npm run build`. Typecheck source and test code with `npm run typecheck -w api`; check the UI with `npm run typecheck -w ui`. Run the existing tests for modules you change. The [commands example](repl/README.md) creates and releases its own browser.

After building, run `npm run verify:application -w api` for an isolated application
check with real Chrome. Set `CHROME_EXECUTABLE_PATH` when Chrome is elsewhere.
It verifies profile reopening, the UI and retry reuse, then removes its worker
and encrypted fixture vault. `TOOLSTACK_QA_OUTPUT` optionally retains screenshots.
An explicit `TOOLSTACK_QA_MUSE_ENV_FILE` also verifies a live, read-only Muse
document using the credential in that environment file; it changes no content.

The authenticated `/documentation/` page provides a static endpoint reference with expandable operation details and schemas. Its OpenAPI downloads remain at `/documentation/openapi.json` and `/documentation/openapi.yaml`.

## Measurement tools

`curl https://steel-browser-production-e8d5.up.railway.app/v1/health` reads health and the deployed revision without a key. [mosaic/stealth_check.py](mosaic/stealth_check.py) provides fingerprint and route measurements; it reads settings from the environment or `~/nosync.nosync/-env/global.env`.

Measurement runs can spend residential bytes. Use a temporary working directory for saved failure pages, and follow [the measurement instructions](STEALTH.md#measuring-detection).

## Licence

Apache 2.0. Preserve [LICENSE](LICENSE), upstream notices and the bundled font licences.
