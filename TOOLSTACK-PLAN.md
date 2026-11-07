# Toolstack plan

Toolstack is being developed as a multi-tenant product. Each organization has
its own members, shared resources and subscription account. A person connects
through their own agent to a private workspace in one organization and receives
their content plus anything explicitly shared with them there.

There is one real organization and one person today. The next step is to make
that organization explicit before adding teammates, then establish isolation for
future customer organizations. Existing `global` sharing must mean organization-wide.

This is the home for product direction, delivery order and acceptance requirements.
[ORGANIZATIONS.md](ORGANIZATIONS.md) defines the planned tenant contract. Other
guides distinguish implemented behavior from that target. The baseline reflects
the repository and recorded checks on 6–7 November 2026. Local implementation,
live checks and production acceptance are separate states.

## Contents

- [Product direction](#product-direction)
- [Current baseline](#current-baseline)
- [Organizations and private workspaces](#organizations-and-private-workspaces)
- [System responsibilities](#system-responsibilities)
- [Capabilities and shared methods](#capabilities-and-shared-methods)
- [Accounts, permissions and company knowledge](#accounts-permissions-and-company-knowledge)
- [Remote work and finished files](#remote-work-and-finished-files)
- [Delivery sequence](#delivery-sequence)
- [Browser acceptance and migration](#browser-acceptance-and-migration)
- [Document ownership](#document-ownership)

## Product direction

The application supplies content management and execution. The owner's Bambu
procedures and Muse skills are examples of content they own. Those packages
apply to the owner when they connect; teammates receive access only after the
owner publishes them globally or assigns them explicitly.

Loading a runtime or deploying application code grants no access to its owner's
content. Keep skill instructions and their tooling, references and configuration
in owned packages. Keep account permissions independent; publishing a method
does not publish its credentials or authorize consequential actions.

People keep their preferred agent. Toolstack supplies authenticated access and
the means to do the work, including workflows that combine several services.
The agent handles the conversation and reasoning; Toolstack owns execution
contracts and durable state.

Browser automation is the first toolkit. Native APIs and remote scripts use the
same discovery and account model. Choose the working access method for each
operation, and give the agent a consistent result regardless of the underlying
service.

Build Toolstack's own capability platform on the existing registry and execution
path. There is no current requirement for Composio or a second MCP gateway.
Evaluate another component when it solves a demonstrated gap without duplicating
account ownership or permissions.

The immediate priority is organization-aware identity and isolation around the
reusable application and toolkit framework. Commercial subscription support must
use those same boundaries when introduced.
Exa remains an optional reference adapter; adding providers follows demonstrated
team needs.

Use Toolstack for the product and new integrations. Keep the existing `STEEL_*`
protocol and storage identifiers compatible with saved clients and profiles.
Complete the hosting display-name cleanup separately, preserving the current
public service address during the transition.

Proactive company agents and listeners that wake individual agents are outside
this plan. Durable execution and explicit result sharing remain useful on their
own and provide a foundation for later collaboration.

## Current baseline

| Area | Implemented or demonstrated | Work still open |
| --- | --- | --- |
| Organizations and subscriptions | One real organization and its owner use the existing standalone service; organization design documented | Explicit organization/membership records, tenant-bound authorization and isolated organization services; billing and paid-customer acceptance |
| Browser engine | Independent agent/quiet browsers, named profiles, managed residential routing and vault login; phases 0–3 accepted | Later routing criteria, long viewing and full soak/fault acceptance |
| Team access | Gateway with invitations, personal keys, browser sign-in and hosted MCP OAuth; dedicated worker and volume per user | Production rollout and real two-user isolation checks |
| Account discovery | Browser/API metadata, profile grants, API verification, enable/disable/disconnect and shared-entry grants | Hosted lifecycle acceptance, deliberate browser-account switching and provider OAuth |
| Tool discovery | Versioned registry, schema lookup, generic execution, on-demand workflow instructions/reference hashes and a catalog release manifest | Coordinated compatible worker releases and teammate acceptance |
| Owned content | Persistent Postgres/Wasabi library, instruction import/editing, supporting files, private/assigned/global permissions and immutable versions; hosted owner release | Owner-content import and registered runtimes for uploaded scripts |
| Native APIs | Provider-independent bindings/execution; Exa and read-only Muse adapters; fixture HTTP/MCP and live Muse read checks | Hosted acceptance and organization-wide pooled accounting |
| Application interface | Catalog-driven Toolkits, Connections and Activity with schema-driven forms, workflow methods and the existing Browser workspace | Hosted user acceptance and further business workflows |
| Files and local client | Prepared deliveries, browser download links, dashboard downloads and an optional verified-save client | Hosted handoff deployment acceptance and optional client release; client is unpublished |
| Browser callers | Twenty-one verified first payloads, with exact windows recorded in the caller ledger | Each caller's normal-use week; DTIC and HathiTrust have no qualifying remote start |
| Substantial remote scripts | Trusted toolkit extension interface | First production workflow, durable jobs and persistent artifacts |

The local Exa pilot preserved a fresh test profile across reopening and used one
named agent's MCP endpoint for browser reads and API calls. It demonstrated usage
limits and retry reuse.

It did not establish production hosting or team isolation. Detailed results
remain in [SEARCH.md](SEARCH.md#verification).

The owner's existing service and profiles must survive the transition. The
documented owner capacity is twelve browser sessions; new-worker defaults are
three. Preserve the actual configured capacity during migration and size new
workers from measured use.

### Implementation and acceptance state

The application/framework checks on 6 November used an isolated worker and real
Chrome. They covered UI discovery/execution, matching MCP schemas and permissions,
retry reuse and interruption, legacy browser/Exa records, profile reopening,
account allowances and mobile content overflow. A live Muse document read returned
its version and acquisition time. Commands and scope are documented in
[framework verification](TOOLKITS.md#framework-verification).

| Stage | Current state | Remaining acceptance or implementation |
| --- | --- | --- |
| 0 — Framework | Application, fixture/UI/MCP proof, persistent owned-content management and its UI implemented; dedicated Railway Postgres and private Wasabi bucket provisioned | Owner-content import and remaining production framework acceptance |
| Organization foundation | Tenant contract and migration/acceptance sequence planned; current deployment remains single-org | Implement initial organization and owner membership, scope every access path and provision independent tenant boundaries |
| 1 — Hosted foundation | Existing owner worker healthy; twelve-session capacity verified and migration generator corrected; owner has not selected a second participant | Separate gateway, compatible rollback, two real people/workers, supported hosted OAuth client and macOS/Windows downloads |
| 2 — Business workflow | Read-only Muse adapter and versioned content-review method implemented; live source read verified | Teammate completion through their own agent, interruption and central-update acceptance |
| 3 — Remote compute | Existing Bambu procedure and scripts inspected | Dedicated bounded runtime, durable job recovery, persistent artifacts and engineering/output acceptance |
| 4 — Creative/business content | Owner's Muse animation skill and canonical anchors located; local preparation/alpha-processing wrapper with validation added | Owner's authorized Higgsfield connection, generation/creative acceptance and dedicated runtime/durable delivery; publication or assignment before other people use the package |
| Browser migration | Existing evidence and caller windows preserved | The route, soak, viewer and elapsed normal-use requirements below remain open |

The owner service received the framework and Library release on 7 November after
its sessions were idle and its volume was backed up. It retains its address,
profiles, vault key and twelve-session capacity. Dedicated Toolstack Postgres and
private Wasabi storage are active, with daily and weekly database volume backups.
No team gateway or compute service has been activated.

The hosted Library passed HTTPS and MCP initialization/discovery/read checks,
private creation, immutable saves and retry replay, encrypted file upload/download,
history, origin/authentication refusal and mobile layouts on 7 November. Its
fixtures and temporary database endpoint were removed. The existing worker also
passed fresh Chrome creation, authenticated CDP, navigation and release. Retained
Newspapers.com and Fold3 member reads passed; Ancestry passed after its native
checkbox challenge was cleared, without password submission. See
[Library verification](LIBRARY.md#verification) for the repeatable checks.

Local fault verification also found a cross-session iframe crash-notification
gap. The backends now forward existing notifications to invalidate affected
references. Crash fixtures wait for the injected fault to be confirmed before
timing recovery. These local checks do not replace the deployed fault/route
acceptance requirements below.

The Bambu source is `/Users/moi/Desktop/3D`, with reusable scripts under
`.claude/skills/bambu-3mf/scripts` and machine settings in `.project/printers.json`.
Its documented method requires a real slice before publication; the default
slicer executable and preset library use BambuStudio's macOS installation.
The local dependency audit stalled in a native SciPy import, including a bounded
twenty-second diagnostic attempt. A Linux runtime has not been accepted. Preserve
the source's geometry checks and original files when resolving this prerequisite.

The Higgsfield animation method is in
`/Users/moi/Desktop/LOST/.claude/skills/create-muse-animation`, with canonical
character anchors in the sibling `create-muse/assets` folder. The global skills
directory does not currently contain it. Its HEVC-alpha encoder requires macOS
VideoToolbox; this part of the pipeline cannot use the Linux browser image.
The Toolstack wrapper reuses the installed scripts and records their hashes.
Its local codec fixture makes no provider request and cannot establish generation
quality or teammate acceptance. See [creative runtime checks](TOOLKITS.md#creative-runtime-checks).
Higgsfield authentication belongs to that content package's connection settings.
Availability of a connector in a development chat does not configure an account
inside Toolstack.

## Organizations and private workspaces

An organization is the customer and tenant boundary. Its members keep private
skills, accounts and execution history, and can explicitly share resources within
that organization. Organization administrators manage membership and shared assets
without gaining access to a member's private workspace.

Personal sharing, organization ownership and account access are independent.
Sharing a personal package leaves its creator in control. An explicit promotion
copies a selected version into organization ownership so it can remain with the
team after offboarding; private history stays with its creator. No publication or
assignment crosses organizations. A future public marketplace needs its own
opt-in process.

Separate global login identity from organization membership. Scope app approvals,
API keys and worker bindings to one membership. The same person in two
organizations has independent workers, profiles and vaults. Bind every request
and delayed job to a verified organization and membership; a supplied tenant ID
or an `admin` flag alone grants no access.

Start with one isolated data service, Postgres database/service and private Wasabi
bucket per organization, with independent credentials and encryption keys. Retain
separate private workers per membership. Shared login and billing services hold
control metadata; organization services hold customer data and their own storage
credentials. Apply database policies and resource grants within those boundaries.

Use the [tenant contract](ORGANIZATIONS.md) for ownership, membership lifecycle and
the operational trust model. Strict user and tenant isolation are release
requirements. Existing single-org tests establish neither multiple-organization
isolation nor paid-service readiness.

## System responsibilities

| Component | Responsibility |
| --- | --- |
| Hosted gateway and control service | Authenticate people and connected apps, verify organization membership and route requests; keep subscription administration separate from data access |
| Organization data service and catalog | Keep its organization's content and grants; resolve personal, assigned and organization-wide access and compatible versions |
| Private workspace worker | Keep one organization's member accounts and browser state; execute permitted operations with private history |
| Organization credential service | Supply explicitly shared account access with membership grants and organization usage limits |
| Execution services | Run substantial scripts in separate runtimes with controlled resources and durable job records |
| Artifact storage | Keep outputs beyond browser-session lifetime and enforce ownership, sharing and retention |
| Company data services | Expose authorized business records and deliberately shared knowledge |
| Subscription and usage services | Associate billing with an organization, enforce entitlements and reconcile measured usage without granting content access |

Keep the gateway small. CPU-heavy modeling and slicing belong in separate
execution services so they cannot consume the team's browser capacity.
Railway is the intended initial hosting environment; a capability can use another
runtime when the actual toolchain requires it.

Keep deployment simple while the team is small. Dedicated private user workers
are the existing isolation model; the target binds them to organization membership.
Shared compute for a job needs an explicit organization and owner in an isolated
working environment. It must not inherit unrelated vaults or profiles.

## Capabilities and shared methods

### Owned content

A content package has an organization, owner, version and visibility. Private
packages apply to their owning membership. Assigned packages also apply to named
active memberships in that organization. Organization-wide packages apply to its
active members. Preserve `global` only as a scoped compatibility identifier; a
filesystem location called "global skills" confers no sharing grant.

Resolve access from the authenticated organization membership across its connected
apps. Preserve ownership on import and on updates. Enforce the same scope on catalog
discovery, instruction/reference retrieval and execution; a worker admin flag
does not grant another person's private content.

The Library implements import, edit, file attachment and publication controls
around persistent owned records. Its REST and MCP access use the same permissions.
Trusted registration remains required to execute a runtime; uploading code stores
content without installing it into the application. See [Library](LIBRARY.md).
Treat the Muse and Bambu material as owner-content acceptance examples. Their
provider accounts and runtime prerequisites belong to their packages.

### A reusable capability contract

A toolkit supplies executable operations and connection requirements; a workflow
combines them with our method and references. Extend the existing catalog to
describe both, loading workflow details on demand. For each workflow, define
the following.

| Part | What it provides |
| --- | --- |
| Purpose and inputs | The requested outcome, validated parameters and required user decisions |
| Instructions | Our working method, recovery steps and limits on what the workflow can decide |
| Dependencies | Required tool versions, permitted account types and execution runtime |
| Reference material | Approved brand assets or the calibrated profiles needed by that workflow |
| Outputs and checks | Expected files or records and the checks that establish completion |
| Execution policy | Permissions, resource limits, cost allowance and retry/cancellation behavior |

Implement this contract through trusted toolkit modules registered with the
existing catalog. Resolve each provider and its permitted tools against that
catalog, including declared credential requirements.

Keep endpoints and provider pricing in the adapter. For supported authentication
and execution types, adding a toolkit should require only module registration.
Preserve existing connection IDs and grants during that change.

Use common metadata to identify the execution owner and describe its state,
preserving tool-specific results and uncertain effects. Extend the existing
runner and ledger; short browser/API operations need no durable-job interface
merely to appear in Activity.

Deliver instructions and references on demand through the hosted connection.
Keep an optional small setup skill for clients that need help discovering them;
ordinary use should retain the current connection flow without local software.

Remote scripts execute centrally. Distribute local packages only for work that
requires the teammate's machine.

Tool discovery alone does not deliver a complete workflow. Add an explicit way to
fetch the applicable instructions and permitted reference assets, with versions
that match the selected tools. Choose that interface after proving it in a real
workflow with the team's agent clients.

### Tooling for our work platforms

Build reusable adapters for the platforms we use. An adapter should provide
validated extraction and dependable actions through Toolstack's browser or a
native API. Reuse that adapter across business workflows rather than repeatedly
asking agents to rediscover page structure.

Return source identifiers and acquisition times with extracted business data.
Distinguish a validated empty result from blocked access, and preserve partial
results and uncertain effects when a request stops. Extend the existing runner's
deadline and retry behavior rather than creating a parallel execution path.

### Central improvements

Version workflow instructions and their tool dependencies together. Record the
version used by a job so its result can be explained and reproduced. Provide a
compatible rollback when releasing an update.

Custom toolkits currently register as trusted application code on each worker.
Central improvement therefore requires a coordinated worker release today.
Introduce a release/catalog mechanism when needed to keep all authorized users
on compatible versions; do not promise immediate dynamic installation before
that mechanism exists.

## Accounts, permissions and company knowledge

Keep the person, external account and browser session distinct. Selecting a
shared company login must still create activity in that person's private worker.
Private sessions and history remain private even when account access is shared.

Show the selected account and whether it is personal or shared. Preserve personal
credential precedence, while making a deliberate account switch explicit and
clearing incompatible saved website state. An account reference must identify
the credential binding used for a job and any retry.

Define configure, verify, disable and disconnect operations for each connection
type. Keep credential deletion, browser-profile deletion and provider-side
revocation explicit and separate. Label saved status as recorded; a live
verification result requires an actual check.

Shared-entry grants are implemented at discovery and secret supply in the current
single-org model. New entries default to the owner; historical unscoped entries
retain their prior installation-wide access. Migration must bind those entries
only to the initial organization and validate their grants before enabling tenant
routing. Missing organization context must not widen access. Validate deployed
grants before using accounts restricted to a department or role. Secret use fetches
current grants rather than relying on the short metadata cache.

The current single-org gateway uses one upstream worker credential per person and
signs the connected key/app identity for that worker. Toolkit policies can inspect the
verified claim; API retries and history distinguish connected apps. Preserve
the existing worker grant names while adding a per-key policy interface. Apply
tool and account restrictions when work starts, including after queue admission.

Keep gateway OAuth and provider OAuth separate. Hosted OAuth connects an agent
to Toolstack; provider OAuth connects Toolstack to an external account. Add
provider authorization and token renewal under the same connection catalog,
with explicit disconnect and reauthorization states.

Revoking a Toolstack connection prevents subsequent permitted use; a website may
retain sessions it already issued. Define how disabling a user affects queued
and running jobs, and report any work that has already acted. Preserve the
existing absence of an owner impersonation endpoint.

Use the company's assigned authority to control consequential operations.
Record the scope authorized by a person and request approval for actions beyond
it. Trusted workflows should offer bounded operations with validated inputs;
arbitrary shell access is outside the shared capability interface.

Company knowledge needs its own explicitly shared records. Publish approved
brand material and completed work to authorized destinations; private browser
history must not become shared company knowledge automatically. Keep sensitive
execution details private while exposing the operational metadata needed for
support and usage accounting.

For business data, begin with authorized read-only operations or curated views
over the existing database. Add narrower data permissions where the business
requires them. A general agent connection must not imply unrestricted access to
the production database.

## Remote work and finished files

### Persistent storage

The dedicated Toolstack Postgres database on Railway already stores the content
library, versions and ownership/assignment records. Keep it separate from PMS
production and bind it to the initial organization during migration. Future
organizations get separate databases/services and credentials. Add durable job
records as execution services are implemented. Preserve existing user aliases
and account bindings through explicit organization/membership mappings.

The existing Wasabi account holds Toolstack's private content bucket with a
bucket-scoped key. Assign it to the initial organization; future organizations
receive separate buckets and keys. Store immutable object keys and checksums
against organization-bound versions in Postgres. Authorize uploads and reads
through the organization service; publishing content changes application grants.

Personal API keys and passwords remain in each user's encrypted vault, with
decryption keys in that worker's server configuration. Shared credential grants
remain separate from content grants. Browser profiles stay on private worker
volumes. Complete the planned cookie-file encryption migration before broader
rollout. Uploaded scripts must execute in isolated runtimes with only their
selected account access, without receiving vault master keys.

Postgres and Wasabi content integration is deployed. Organization binding,
separate migration/request database roles and the tenant storage/key lifecycle
remain implementation work. Worker/gateway files remain authoritative for their
existing account and membership records until explicit migrations are verified;
keep one authority for each record throughout the transition.

### Durable jobs

Add a job interface for work that can outlive an HTTP request or agent connection.
Submission returns an owned job ID; the agent can inspect progress and retrieve
results later. Cancellation and reconnection must have defined behavior.

Persist recovery inputs and the capability version in private job storage with
the selected account binding and a retention policy. Resolve secrets from account
references.

Keep state transitions and validation results durable. Preserve uncertain external
effects so restarting a worker cannot silently repeat a generation or submission.

Start with one dedicated execution service and bounded concurrency. Add a durable
queue when required for long-running work, using the Toolstack Postgres job
store. The short-lived operation runner and its response cache do not constitute
durable job recovery.

### Artifacts and budgets

Store finished models and creative assets in Toolstack's private Wasabi bucket.
Give each output an owner and a retention policy;
make sharing an explicit operation. Support verified download and cleanup after
failure without deleting a completed result that has been published.

The current thirty-minute browser handoff is useful for immediate downloads.
Durable workflow outputs need a lifecycle independent of the browser and worker
restart. Reuse the delivery interface where appropriate while keeping that
distinction visible to the agent.

Bound CPU and memory per job. Keep model-generation or slicing resources separate
from browser resources and use a private working directory for each job. Measure
real runtime and storage costs before setting team allowances.

Track usage by person and capability. Shared subscriptions and API keys also need
organization-wide accounting; independent per-worker ledgers cannot enforce a single
pooled limit. Preserve the existing distinction between local cost reservations
and the provider's actual bill.

## Delivery sequence

Stages below describe dependencies rather than promised dates. The existing
browser observation periods and hosting preparation can continue alongside
framework work. Passing a local check does not complete a production stage.

### Organization delivery

Implement these steps around the framework before expanding access. Detailed
semantics are in [ORGANIZATIONS.md](ORGANIZATIONS.md).

1. Establish the initial organization and its owner membership. Add organization
   and membership context throughout the schema, signed claims and resource
   grants. Backfill existing content and account bindings explicitly. Constrain
   legacy owner/named keys to that organization; unbound new requests fail closed.
   Preserve profiles, public endpoint and twelve-session owner capacity. Keep
   encrypted object keys readable during any authenticated copy or re-encryption.
2. Isolate the organization's shared service from private membership workers.
   Split database migration authority from request access, enforce row policies
   and provision storage/key boundaries. Recheck queued work, downloads and live
   connections after revocation. Review migration mappings and verify a rollback
   that cannot drop organization checks or restore removed grants.
3. Invite the first real teammates into that organization when selected. Verify
   personal privacy and explicit content/credential sharing through their own
   workers and agents. The owner has not yet selected these people; synthetic
   fixtures can establish code behavior while real acceptance remains pending.
4. Before admitting an unrelated organization, provision a second isolated test
   tenant. Exercise two memberships in each and the same login in both. Verify
   that an owner/admin in one cannot discover or act on foreign content, workers,
   credentials or billing records, even with valid foreign IDs. Require direct
   database/storage denial and network isolation alongside API checks. Cover
   caches, search, retry collisions, jobs, restores and deletion. Independently
   review the threat model and demonstrate fair resource limits under load.
5. Before paid external use, implement organization subscriptions, billable units
   and durable usage reconciliation. Verify billing-event signatures, duplicate
   and out-of-order handling, plan changes and cancellation/export behavior.
   Exercise onboarding, last-owner recovery and offboarding. Establish measured
   service targets, restore procedures and incident support, then complete an
   independent security assessment. No security or compliance certification is
   implied by this plan.

Acceptance must include missing/forged tenant context and stale membership or
app grants on REST, MCP, CDP and live downloads. Suspension must stop new work and
disconnect controlled live access within a measured five-second target; work
already sent to an external provider retains its actual or uncertain effect.
Confirm that an organization administrator cannot read another member's private
history or use export/support tooling to bypass that boundary.

Current single-org verification remains useful regression evidence. Multi-tenant
acceptance requires the deployed organization-aware paths and independent tenant
resources; changing UI labels or adding an `org_id` filter is insufficient.

### 0. Complete the application and toolkit framework

Make toolkit registration independent of providers throughout the connection
and execution services before expanding the catalog. Use the contracts above
for account lifecycle and execution controls; existing vault and browser
authentication must remain usable.

Build the application around Library, Toolkits, Connections, Activity and the
existing Browser workspace. Show the active organization and distinguish My
workspace from Organization resources. With one membership, avoid an unnecessary
organization-selection step. Let users run permitted tools from their schemas.

Add the persistent library for owned skills and tooling. Let the owner import and
edit a package, publish it globally or assign it to selected people, and withdraw
that access. Keep the package's version and its runtime/account requirements with
the content. Connecting must resolve the person's current content grants.

Show account scope and usage limits, with actionable connection states. Read
these views from the catalog and shared application services so the UI and MCP
enforce the same permissions.

Accept this stage by registering one local API toolkit with fixture credentials
without changing core schemas or transport handlers. Demonstrate discovery and
execution through both the UI and MCP, including denied access and retry after
interruption, using the same connection and execution services as Exa.

This proof requires no new external account. Verify that existing browser and
Exa connection records remain usable and that saved profiles survive the change.

### 1. Accept the hosted foundation

Deploy the gateway as a separate service and retain the existing endpoint as the
owner's worker while validating the new path. Preserve its volume and keys.
Use an idle deployment window and keep a recent compatible rollback, following
[the deployment procedure](DEPLOYMENT.md#deployment-and-rollback).

Use two people with separate workers. Exercise both personal and shared account
access through deployed REST, MCP and CDP connections. Foreign session IDs must
be refused, and each person must see only their own sessions and history.

Local mock-worker checks cannot establish hosting isolation.

Accept the hosted OAuth flow through a supported agent client, including
disconnect and revocation of live proxied connections. Demonstrate the browser
and a native API toolkit through the same authenticated hosted connection, with
a fresh saved test profile and a small explicit API allowance.

Check account grants and normalized API results, including private execution
history and a budget refusal. Confirm that a transport retry reuses the existing
execution instead of issuing another provider request.

Accept ordinary browser downloads on macOS and Windows, including a handoff
after closing its remote browser. Check expiry and unauthorized access. Keep
automatic verified saves optional, and publish the local client only when its
release is ready.

Record the gateway and each activated worker in Mosaic's infrastructure registry.
The registry must also cover any new persistent process before activation.

### 2. Prove owned-content use and sharing

Import one of the owner's existing skills with its tooling and references.
Demonstrate private discovery and execution through the owner's connection.
An unrelated person must not retrieve the package's tools, instructions or files.
Then exercise explicit assignment and organization-wide publication as separate changes,
including withdrawal of access. Select a real teammate before provisioning or
assigning their content.

Use a complete business workflow as the content example. Have an assigned
teammate complete it through their own agent without local tool setup.

Acceptance requires the expected output and its validation, using the intended
account and respecting the person's permissions. Exercise an interrupted run
and a central update. The teammate must benefit from the updated method without
reinstalling tooling.

### 3. Prove substantial remote execution

Use the owner's existing 3D modeling and Bambu package as the first substantial
compute example. Its engineering rules remain owned content. Inspect its actual
scripts and dependencies before selecting the Linux
runtime. Identify any desktop or local-network requirements instead of assuming
that the entire pipeline already works headlessly.

Reuse the calibrated modeling and slicing procedures. A job should return its
3MF print project and STL where applicable, with a preview and validation report.
Include available print estimates.

A teammate should be able to modify a design and obtain the same engineering
checks without installing the toolchain.

Prove durable job recovery and retrieval of artifacts after disconnect. Confirm
that a compute-heavy job leaves other users' browser operations within their
resource budgets. Direct delivery to a local printer can use a separate bridge
when needed; producing the file should remain independently useful.

### 4. Expand creative and business capabilities

Import the owner's Higgsfield branded-asset tooling with approved brand references
and the established production method as an owned package. Publish or assign it
only at the owner's instruction. Support business outcomes such as an
event campaign adapted to the intended venue. Keep generated candidates and
their review status with the finished artifacts.

Use the account arrangement and access method actually available for the team.
Verify the workflow against that arrangement; website subscription access and
API billing must not be treated as interchangeable. Keep the provider adapter
replaceable while preserving the workflow contract.

Extend the same model to authorized business reporting and other work platforms.
Prioritize a demonstrated recurring task over the size of the integration
catalog. Implement provider OAuth when a selected integration needs it.

Trigger delivery and a shared work pool are later extensions. Keep a business
assignment distinct from a compute job; an assignment may require a person's
decision or several jobs. Add these features around demonstrated team needs,
without introducing proactive company monitoring in this phase.

## Browser acceptance and migration

These requirements consolidate the former review plan and remaining browser
work. Preserve the measured results in [STEALTH.md](STEALTH.md) and the caller
windows in [mosaic/CALLERS.md](mosaic/CALLERS.md). Repeat relevant checks after
changes to browser behavior; retain failed and interrupted measurements.

### Remaining browser work

| Work | Requirement or unresolved condition |
| --- | --- |
| Managed routing | Retain route pass rates on the cheapest working route and reduce residential bytes by at least half against the accepted phase 3 baseline |
| Proxy acceptance | 20 of 20 matching exit timezones, demonstrated budget termination and retry recovery; retain the existing budget-stop evidence |
| Bizapedia | Meet both the 18/20 people-page pass mark and the 50% byte reduction; the final free quota prevented a qualifying set and successful pages missed the byte target |
| Retained login | Evaluate corrected `readVersion:2` daily observations for `ancestry` over 5–12 November UTC, on or after 12 November; preserve earlier validator failures separately |
| Fold3 viewer | Complete the three-hour viewer requirement; the interrupted measurements establish no three-hour pass |
| HathiTrust | Resolve remote payload access separately from Google login; preserve the persistent one-attempt Google limit and the failed attempt |
| Caller migration | Evaluate every exact normal-use window and establish real browser starts for DTIC and HathiTrust |
| Session summaries | Record mode, identity, exit/region, Chrome version, bytes, duration, end reason and challenge outcome |
| Failure recording | Retain the last two minutes only when a job fails, subject to protected-profile capture restrictions and private artifact handling |
| Soak and faults | Complete the thresholds below |
| Further isolation | Validate Chrome sandboxing, comprehensive internal-network filtering and encrypted cookie-file migration for compatibility |
| Weekly canary | After acceptance, run one probe and three routes; register the autonomous process before activation |

The direct Anna acceptance and Mary Ferrell logout/re-login checks have passed.
The known Ancestry profile passed retained reads after deployments and a Chrome
crash. Keep those results distinct from the unfinished long-run requirements.

### Fingerprint checks

Use 20 sessions on 20 exits with Evomi Core unless the route specifies direct
access. Record the exit IP and TCP operating-system guess with Chrome's version.

| Check | Pass mark |
| --- | --- |
| deviceandbrowserinfo.com | No bot flags in 20 of 20 |
| bot-detector.rebrowser.net | Every CDP and automation check passes with Patchright connected; retain the recorded acceptance of neutral checks where the fixture cannot observe them; no positive detections |
| `navigator.webdriver` | `false` |
| Browser brands | Include Google Chrome at the pinned version |
| Timezone against exit, using the same geolocation service | Match in 20 of 20 |
| `hardwareConcurrency` | Same in page, dedicated worker and service worker; at most 16 |
| WebRTC at browserleaks.com/webrtc | No address except the exit's |
| WebGL | llvmpipe through ANGLE, stable across sessions |
| CreepJS | No lie or headless markers; ignore its trust score |
| BrowserScan and Pixelscan | Record advisory results; they do not override real-target outcomes |

Real targets determine route acceptance. Use Rebrowser for CDP leaks and Device
and Browser Info for fingerprint regressions.

Keep CreepJS inconsistency findings. Sannysoft and BotD add no required acceptance
threshold.

### Route checks

Use 20 runs each across at least 10 exits for the residential route matrix.
Keep separately scoped direct-route measurements identified as such.

| Route | Pass mark |
| --- | --- |
| Utah Digital Newspapers, Newspapers.com sign-in, Fold3 login and Ancestry sign-in | 19 of 20 |
| Bizapedia people page | 18 of 20 |
| Anna's Archive search | 16 of 20 first try; 19 of 20 with one retry on a new exit |
| Every route | No more than one failed run beyond the better of the measured Toolstack and Browserbase baselines |

### Logged-in use

| Check | Pass mark |
| --- | --- |
| Daily jobs on Ancestry, Newspapers.com and Fold3 for seven days | No sign-in prompt after initial login and no new-device check |
| Profile survival | Login survives two deployments and one `kill -9` of Chrome |
| Three-hour Fold3 viewer session | Exit IP checked every five minutes; Chrome memory below 2 GB and no crash. If the exit changes, the client restarts the session and the site retains the login |

### Soak and faults

| Check | Pass mark |
| --- | --- |
| 200 mixed-route sessions over 24 hours | No Chrome processes left after release; service memory returns within 50 MB of its start; every session has a logged end reason; forwarder errors below 1% |
| `kill -9` Chrome mid-page | Client receives an error within five seconds and its retry succeeds |
| Invalid proxy credentials, then an unresponsive upstream | Clear error within 30 seconds without a hang |
| Deployment during a session | Work finishes within the draining period, or fails cleanly and Browserbase completes the job |
| Two clients claiming `ancestry` | Second client receives 409 |
| Three simultaneous throwaway sessions | Route pass rates unchanged and memory within the service's allocation |

### Caller review and Browserbase retirement

Use each caller's exact start and exclusive end from the caller ledger. Flush
queued outcome metadata before querying those ranges. Sum `failedOrFallback`
and divide by `attempts` across all returned UTC-day rows for that caller.

Require less than 10% failed or fallback runs, zero unresolved unknowns and seven
elapsed days with sufficient normal collection use. Diagnostic runs and repeated
acceptance probes cannot establish normal use. A repair must retain earlier
failures and the original verified window.

DTIC and HathiTrust require their own starts after real remote browser payloads
are verified. DTIC's repaired live-PDF path also needs a real PDF after service
restoration. Mirror success and local HathiTrust UI access do not qualify as
remote browser passes.

Keep Browserbase branches and credentials, including the existing family
context, until every moved caller passes its own window. A successful first run
cannot establish a week's reliability. Preserve the `lostprojects/toolstack`
repository and the existing production volume throughout the migration.

## Document ownership

Keep new planning and acceptance requirements here. Update the baseline when
evidence changes, and link to the detailed measurements rather than copying a
run history into this plan.

| Document | Responsibility |
| --- | --- |
| `README.md` | Current product description, entry points and guide index |
| `ORGANIZATIONS.md` | Planned tenant contract, personal/organization ownership, isolation model and subscription foundation |
| `DESIGN.md` | Implemented component responsibilities and behavior |
| `TEAM.md`, `DEPLOYMENT.md` | Provisioning and operating procedures |
| `TOOLKITS.md`, `SEARCH.md` | Implemented toolkit contracts and usage |
| `USAGE.md`, `COMMANDS.md`, client guides | Current interfaces and client instructions |
| `STEALTH.md`, `mosaic/CALLERS.md` | Measurements and exact observation windows, including failures |
| `REVIEW.md` | Compatibility pointer to the acceptance requirements in this plan |
