# Toolkits and discovery

Toolstack's registry exposes browser operations, account connections and permitted
content packages alongside [Exa search](SEARCH.md) and API usage. Muse procedures
and tooling are personal content installed explicitly for their owner.
[TOOLSTACK-PLAN.md](TOOLSTACK-PLAN.md) owns direction and acceptance requirements.

Toolstack registers its browser operations as the `browser` toolkit. Agents can
discover tools by keywords, inspect their schemas and execute them through the
authenticated `/mcp` endpoint. This runs within Toolstack and needs no Composio account.

## Agent interface

| Tool | Arguments | Result |
| --- | --- | --- |
| `tools_search` | `query`, optional `toolkit`, `limit` and `offset` | Matching tools with input schemas, toolkit versions and authentication descriptions |
| `tools_describe` | `name` | One tool's schema, toolkit version and authentication description |
| `tools_execute` | `name`, `arguments`, optional `version` | The target tool's original MCP result |

For example, call `tools_search` with:

```json
{"query":"download PDF","toolkit":"browser","limit":5}
```

Call `tools_describe` with `{"name":"browser_download"}` to inspect that tool.
Then call `tools_execute` with the discovered arguments:

```json
{
  "name":"browser_download",
  "version":"1.3.0",
  "arguments":{
    "session":"SESSION_UUID",
    "url":"https://example.org/report.pdf",
    "idempotencyKey":"report-download-1"
  }
}
```

Supply a real session ID from `browser_open`. The result has the same content,
images, file links and error state as a direct call. Preserve the target tool's
retry keys and status/cancellation workflow; generic execution adds no retries.

Search uses local keyword matching against tool names, descriptions and optional
keywords. It returns five tools by default, at most twenty, with `total` and
`nextOffset` for pagination. No results produces an empty list. A toolkit version
mismatch returns `version_mismatch` before running the tool.

By default, MCP lists the existing browser tools and the discovery tools. Set
`MCP_TOOL_EXPOSURE=discovery` to list only the three discovery tools and load
individual schemas as needed. The plugin option `mcpToolExposure` overrides the
environment. This controls listing; it does not restrict direct execution.

## Existing accounts

The `connections` toolkit describes accounts already held by this Toolstack worker.
It reads permitted vault metadata and saved profile directory names, alongside
the existing site mappings and login observations. It does not extract passwords
or read Chrome's cookie databases.

| Tool | Operation |
| --- | --- |
| `connections_list` | List available connections; accepts `limit` and `offset` |
| `connections_get` | Read one connection's status and permissions by `id` |
| `connections_configure` | Admin-only profile settings or full API binding and usage policy |
| `connections_verify` | Run a declared, bounded API verification using its normal allowance |
| `connections_access` | Admin-only enable, disable or disconnect of an account binding |

Browser connections have IDs such as `browser:ancestry`. Call `connections_list`,
then open the selected account:

```json
{"connection":"browser:ancestry","site":"fold3","caller":"my-agent"}
```

Pass this object to `browser_open`, or use the `connection` field in
`POST /v1/sessions`. The selected profile remains fixed. An explicit conflicting
identity or a site requiring a different identity is refused. For a manual
profile without a default site, supply a URL or open it on its initial blank tab.

`profileSaved` reports a saved profile directory. `unverified` means there is no
usable recorded login observation. `last_verified` describes the latest positive
observation; it does not confirm that cookies are valid now. A later failed check
produces `needs_login` or `verification_required`. Per-site observations include
their timestamps and last successful login time, with exit IPs omitted.

Supported vault accounts are associated with their existing browser identities.
Other permitted vault entries appear as `vault:NAME`, with `credentials_available`
or `locked` status. They need an explicit browser integration before they can be
selected by `browser_open`; Toolstack does not guess a profile or expose their values.

Configured API accounts appear as `api:NAME`, with their permitted tools and
daily limits. [SEARCH.md](SEARCH.md) documents configuration, usage and retry
behavior. An API binding replaces the duplicate generic vault row in the catalog.

An admin can configure a profile connection with:

```json
{
  "id":"browser:research-profile",
  "label":"Research account",
  "site":"https://example.org/",
  "allowedAgents":["mosaic"]
}
```

Pass this to `connections_configure`. REST provides `GET /v1/connections`,
`GET /v1/connections/ID` and `PUT /v1/connections/ID`; omit `id` from a PUT body.
List responses return `total` and `nextOffset`, with fifty rows by default and
at most one hundred. `sharedStoreAvailable: false` marks a partial catalog during
a shared-store outage; private metadata remains available and missing shared
connections are refused.

Single-account lookup resolves the requested ID directly. It does not enumerate
profile directories or resolve other accounts' configured sites. Listing builds
one routing snapshot and indexes observations once; REST and MCP use the same
pagination method. Browser, vault and API entries have explicit TypeScript types,
exported as the `Connection` union from the API plugin.

Vault metadata can also be looked up directly by a permitted `vault:NAME` ID
when the list represents that credential through a browser connection. Selecting
that vault ID for browsing still requires a browser profile mapping.

Configuration lives in `/data/connections.json`, containing profile settings
and API credential references with grants and limits. New records default to admin access. Grants are enforced when creating
sessions through connection IDs or raw profile identities, including REST and
collector routes. Protected profiles also require their existing vault permission.
Changing grants leaves existing sessions and website logins in place.

Legacy profiles retain their existing raw-profile access rules until configured.
Discovery shows unconfigured profiles to admins, agents already associated with
them, or agents permitted by the protected profile's vault entry. In team mode,
each person's account metadata remains on that person's worker volume. Grants
use the worker's agent identities, as described below.

## Register a toolkit

Register trusted server-side implementations through `ToolstackConfig.toolkits`.
The same tools become available through direct calls and discovery. The registry
refuses duplicate toolkit IDs, duplicate tool names and discovery-tool names.

```ts
import { z } from "zod";
import toolstackPlugin, { type Toolkit } from "@toolstack/api/plugin";

const utilities: Toolkit = {
  id: "utilities",
  name: "Utilities",
  version: "1.0.0",
  description: "Local text utilities",
  authentication: "Uses the authenticated Toolstack key; no external account",
  tools: [{
    name: "utilities_character_count",
    description: "Count Unicode code points in supplied text",
    keywords: ["length", "characters"],
    input: z.object({ text: z.string().max(100_000) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: (args) => ({
      content: [{
        type: "text",
        text: JSON.stringify({ count: Array.from(args.text as string).length }),
      }],
    }),
  }],
};

await app.register(toolstackPlugin, { toolkits: [utilities] });
```

Tool and toolkit identifiers use lowercase letters, digits and underscores,
starting with a letter, up to 64 characters. Each tool supplies a Zod object
schema and a handler returning an MCP `CallToolResult`. Increment the toolkit
version when its tool contract changes.

## Access and execution

Owned packages declare `content` metadata. Use the person's stable Toolstack user
ID for `owner` and assignment entries; connected app keys do not own content.
For example, `contentAccess.parse({ id: "my-tools", owner: "alice" })` supplies
private defaults. Set `visibility: "assigned"` with `assignedTo: ["bob"]` for an
explicit assignment, or `visibility: "global"` for organization-wide publication.
Import `contentAccess` from `@toolstack/api/plugin`.

This is the existing single-org contract. The [planned tenant contract](ORGANIZATIONS.md)
adds verified organization/membership scope to discovery, credentials and execution.
Do not use the current unqualified owner IDs or `global` metadata to serve
unrelated organizations. A registered runtime grants no access to tenant content.

These grants apply to discovery, execution and workflow/reference retrieval.
The catalog shows ownership and visibility, while assignment rosters stay out of
public metadata. Sharing content grants no account access; existing credential
and operation policies still apply. Trusted startup configuration supplies these
records for executable toolkit modules. The persistent [Library](LIBRARY.md)
implements owned instruction/file editing and publication. Uploaded content
does not install a runtime. Organization-aware ownership and grants remain planned.

`content-access.test.ts` checks private content against another person's admin
key, explicit assignment and global publication with independent tool policies.
The application check installs Muse content privately for its fixture owner and
verifies the scope label in the real browser. An ordinary application catalog
contains no Muse package unless it is installed explicitly.

Toolkit and tool definitions can each supply a synchronous `authorize(context)`
function. Both must return `true` when supplied. Toolstack applies them to listing,
search, description and execution, including direct calls. Unavailable tools
return the same `tool_unavailable` error whether absent or unauthorized.
A thrown authorization error denies access without exposing the exception.

The server supplies `context.agent`, `context.requestId` and `context.signal`.
Clients cannot override them through tool arguments. Handlers receive validated
arguments, including schema defaults, and should pass the abort signal to
cancellable external requests. An ended MCP connection aborts that signal;
existing browser executions retain their status/cancellation behavior.

Authorization callbacks see the worker identity and, on updated team deployments,
`context.agent.connectedApp`. The gateway signs this claim for the assigned
worker; it includes the person's ID and the connected key or OAuth grant ID.
Worker grants retain their existing names. API retry identities distinguish
connected apps, and queued API/browser work rechecks authorization at admission.

Handlers are trusted application code. Keep credentials within the service,
return sanitized results and handle provider-specific retry guarantees there.
Throw `PublicError` from `@toolstack/api/plugin` for an intended public
failure, supplying its code, safe message and status code. The dispatcher uses
this shared contract for all toolkits and hides unexpected exception details.
Toolstack scrubs known secrets from result text and metadata on both execution paths,
preserving encoded image, audio and file bytes. Handlers remain responsible for
what those binary artifacts contain.
Authentication descriptions explain requirements. The connection catalog reuses
the existing browser login flows. The native [Exa connector](SEARCH.md) uses the
same registry and vault-backed API connections. Provider OAuth is not implemented;
its requirements are in [the plan](TOOLSTACK-PLAN.md#accounts-permissions-and-company-knowledge).

The local client's `browser_save` remains a local operation outside the remote
registry. Use it to receive and verify a remote delivery on the user's machine.

## Application and account lifecycle

`GET /v1/toolkits` returns the permitted catalog and its release hash.
`GET /v1/tools/NAME` returns a schema, and `POST /v1/tools/NAME/execute` accepts
`{"version":"VERSION","arguments":{}}`. It returns the same MCP result as
`tools_execute`. The application builds its forms from these schemas.

`GET /v1/activity` returns private API metadata and the caller's browser sessions.
API history has seven-day retention. It records the capability version and the
credential reference and scope used, excluding provider response bodies and keys.

`POST /v1/connections/ID/verify` runs the adapter's declared verification tool.
Read `verification.estimatedCostUSD` first; Exa reserves up to $0.01 and one call.
Supply an `Idempotency-Key` header when retrying this REST operation. Verification
uses normal grants, limits and retry protection, and keeps the original result
time on replay. The catalog's `configured` state remains recorded metadata.

`POST /v1/connections/ID/access` with `{"enabled":false}` disables future use;
`true` enables it. `DELETE /v1/connections/ID` disconnects the binding. These
operations preserve vault entries and saved browser profiles. Provider revocation,
credential deletion and profile deletion remain separate explicit operations.
Queued session creation rechecks profile access after waiting for capacity.

## Register a native API

Use `ToolstackConfig.apiToolkits` for vault-backed key authentication. A definition
provides its identifier, version, credential fields and `actions`; no provider
enum or transport changes are required. Define action inputs by extending
`apiActionInput` from `@toolstack/api/plugin`.

Each action supplies a name, description, input schema, optional authorization
and MCP annotations, a conservative `reserveMicros(args)`, and `run(args, key,
signal)`. The shared executor owns account resolution, deadlines and durable
usage reservations. Zero-cost operations may reserve zero; call limits still
apply. Endpoints and pricing stay within the adapter. Set read-only annotations
explicitly when appropriate; the framework does not assume that API calls read.

An optional `verification` declares a registered tool, bounded arguments and an
estimated USD cost. It uses the same action and ledger as an ordinary invocation.
Bindings retain their existing IDs and grants; omitted `allowedTools` selects the
provider's registered tools permitted to the configuring administrator.

The optional owner-content module `api/src/content/muse-content.ts` exposes
`muse_documents` and `muse_document`. It is absent from default app registration;
`museContentToolkit(ownerId)` installs it privately for that person. It reads only
current pages and venue settings through the established admin API, using fixed
origins and bounded, validated responses. Results include document versions,
source IDs and acquisition times. This interface exposes no SQL or guest records.

## Working methods and references

A trusted toolkit can declare `workflows` alongside executable tools. Each method
has its own version, input schema, instructions, exact tool-version dependencies,
declared references, outputs and completion checks. Its policy describes authority,
runtime and interruption behavior. Workflow packages may have no tools of their own.

Use `workflows_list`, `workflows_get` and `workflows_reference` through MCP.
REST supplies `/v1/workflows`, `/v1/workflows/ID?version=VERSION` and
`/v1/workflows/ID/references/REFERENCE?version=VERSION`. References contain declared
text only and carry SHA-256 hashes. An ID cannot select a filesystem path or an
arbitrary URL. Denied or incompatible dependencies make the method unavailable.

The catalog release hash covers tool schemas and workflow/reference manifests.
Contract definitions remain immutable after registration. Releasing changed
trusted code still requires coordinated worker deployment; this mechanism does
not dynamically install modules. Preserve a compatible release for rollback.

`muse_content_review` packages the existing content-review procedure and its
publication constraints. The application shows the method and lets a person copy
a prompt for their connected agent. Retrieving instructions does not execute
their operations or authorize publication.

## Framework verification

`application.routes.test.ts` registers an independent fixture provider through
the plugin option. It exercises the real HTTP MCP client and application routes,
including matching schemas, denied access and retry after interruption. It also
loads prior browser/Exa records and checks preserved grants and profiles.

`npm run verify:application -w api` uses the built app and real Chrome. It checks
profile reopening, method loading and tool execution through the UI, retry reuse,
account creation/access controls, allowances and private activity. Its light/dark
desktop/mobile checks include navigation, JSON form round-trips, inner content
overflow and browser errors. Optional live Muse verification makes one
bounded document read. These local checks do not establish hosted isolation,
teammate acceptance or Windows download behavior.

The 6 November verification passed all 41 test files (476 tests, with two large
document checks skipped by default). The extended document run passed all 20 tests,
including those two checks, covering all 478 distinct tests across both runs.
API/UI type checks, production builds and the standalone gateway import also passed.

## Creative runtime checks

`content/muse-animation/runtime/muse_media.py` wraps the owner's established
`create-muse-animation` scripts. This package is personal application content;
it is absent from the app's default toolkit catalog.
It prepares opaque white stills and verifies HEVC-alpha, VP9-alpha and poster
outputs before publishing a complete output directory. It records the installed
script hashes, runtime versions and output checksums; outputs retain candidate
status for visual review.

The installed method is at
`/Users/moi/Desktop/LOST/.claude/skills/create-muse-animation`. Its sibling
`create-muse/assets` contains the canonical character anchors. The source files
remain unchanged. Set `TOOLSTACK_MUSE_ANIMATION_SKILL` to the installed skill
folder or pass `--skill-root` to the commands below.

```bash
python3 content/muse-animation/runtime/muse_media.py doctor --skill-root /path/to/create-muse-animation
python3 content/muse-animation/runtime/muse_media.py prepare --skill-root /path/to/create-muse-animation \
  --input source.png --output prepared
python3 content/muse-animation/runtime/muse_media.py encode --skill-root /path/to/create-muse-animation \
  --input loop.mp4 --output candidate --ink 1b2436
```

The bounded input contract accepts PNG stills up to 1440px. Clips may be at most
1440px per edge, twelve seconds and thirty frames per second, with at most 360
frames. Inputs may be at most 100 MiB. Subprocesses have deadlines and their
process groups stop on timeout or interruption. Failed checks publish no output
directory, and existing output directories are preserved.

Encoding requires macOS, system ffmpeg with `hevc_videotoolbox` and `libvpx-vp9`,
and ffprobe. The Python runtime requires NumPy and Pillow. The wrapper checks
four decoded frames from each video, including the VP9 decoder required to see
its alpha, and verifies the poster. It compares every native alpha frame at
64×64 to check the loop seam. A colour-only comparison would miss motion because
the recoloured video's RGB plane is constant.

Run the regression checks with
`python3 -m unittest discover -s content/muse-animation/runtime -p 'test_muse_media.py'`.
The real-codec fixture uses the installed scripts and a supplied reference:

```bash
python3 content/muse-animation/runtime/verify_muse_media.py --skill-root /path/to/create-muse-animation \
  --reference /path/to/muse-anchor.png
```

The fixture makes no provider call and removes its temporary outputs. It verifies
preparation, both alpha codecs and output checksums with a static two-second clip;
it cannot verify a generated character's appearance or motion. The wrapper also
rejects a visible loop seam, an oversized clip and an opaque alpha plane even if
the source encoder returns success.

This is a local runtime prerequisite. It has no public tool, durable queue or
artifact-retention service. Dedicated resource limits and those services remain
required before hosted execution. A confirmed Higgsfield account connection and
review of generated motion remain required for creative acceptance.
