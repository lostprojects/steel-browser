# Owned content library

The Library keeps a person's skills, workflows and supporting files in dedicated
Toolstack Postgres and private Wasabi storage. New packages belong to the
authenticated person and start private. Their owner can assign them to named
people or publish them across the current organization.

The deployed Library is still single-org: its schema and signed identity do not
yet carry an organization binding. The [organization contract](ORGANIZATIONS.md)
defines the planned isolation and ownership model. Existing `global` visibility
must map only to the initial organization during migration. Do not connect
unrelated organizations to this unscoped database or bucket.

Use **Library** in the dashboard to create a package, import Markdown or text
instructions, attach files and manage sharing. Save instructions before uploading
supporting files. Each save, file upload, sharing change and archive action creates
an immutable version. History lets the owner inspect a version and restore its
instructions and file selection as a new version.

Sharing applies to the current version. Earlier versions and removed files remain
available to the owner. Revoking access also revokes existing download addresses;
every request checks the current permissions. Archiving withdraws the package from
other people and keeps the owner's history available for restoration.

The planned model adds organization ownership separately from visibility.
Sharing a personal package leaves its creator in control. Explicit promotion
copies one selected version and its files into organization ownership; private
history stays private. Assignment targets active memberships of the same
organization. These controls require implementation; the API below describes
the current Library contract.

## Instructions and execution

Library packages are application content. Instructions can refer to installed
tools and declare a compatible runtime. Uploading a script stores it for authorized
retrieval; execution requires a separately registered runtime with its own limits
and account permissions. Publishing content does not publish account credentials.

Supporting files use individual names. Upload a ZIP if a script needs a directory
tree; Toolstack stores the archive without extracting or running it. The current
interface imports one instruction file and attaches one supporting file at a time.

The generic `library` toolkit exposes `library_list`, `library_get`,
`library_create`, `library_update`, `library_share`, `library_archive`,
`library_upload` and `library_file`. Discover their schemas through the existing
catalog. UI, REST and MCP requests use the same service and permission checks.
MCP uploads accept up to 1.4 million base64 characters; use the dashboard or REST
for larger files. `library_file` supplies an authenticated download resource.

REST starts at `/v1/library`. List with GET, create with POST, read a package with
`GET /v1/library/:id`, and update with PUT. The package's `/share`, `/archive`
and `/files` endpoints accept POST. `/history` lists the latest 100 revisions;
`?version=N` reads a specific revision for its owner. Download with
`GET /v1/library/:id/files/:fileId`; HEAD checks access and metadata without
reading the stored bytes.

All mutations require a UUID `requestId`. Reuse it with an identical payload after
a timeout. Edits require `expectedVersion`, and updates supply the exact retained
file IDs. A concurrent edit returns 409 instead of overwriting someone else's work.

## Storage and secrets

Postgres holds ownership, sharing, instructions and immutable versions. Wasabi
holds files encrypted with AES-256-GCM, with the object key authenticated as
associated data. Uploads include a ciphertext MD5; downloads verify the stored
length and plaintext SHA-256. Files have authenticated application addresses and
are served as attachments. The bucket has no anonymous access.

The central gateway holds the database URL, scoped Wasabi key and separate
`TOOLSTACK_CONTENT_KEY`. Private workers call it using their assigned reader key;
they refuse startup with central storage credentials. The existing standalone
owner service can host the library during the team rollout. Named standalone
client keys use that service's one owner identity. Separate people require the
gateway and their own workers.

For multi-tenant deployment, move this storage authority into an organization
data service with its own database, private bucket and encryption key. The shared
gateway routes authenticated membership context without holding every tenant's
storage credentials. Private workers remain bound to one membership. Existing
object keys authenticate the encrypted bytes, so changing their paths requires
an authenticated copy/re-encryption and verified metadata cutover.

API keys and passwords continue to use the encrypted vault on each private
worker's volume. Browser cookies remain in its profile. Explicit shared account
entries use the gateway's encrypted shared store. These secrets are separate from
package files and sharing permissions. Never upload credentials as package content.

## Configuration and operation

Configure these together on the central service. There is no PMS connection or
fallback to a generic `DATABASE_URL`.

| Variable | Purpose |
| --- | --- |
| `TOOLSTACK_DATABASE_URL` | Dedicated Toolstack Postgres application account |
| `TOOLSTACK_WASABI_BUCKET` | Private Toolstack bucket |
| `TOOLSTACK_WASABI_REGION` | Bucket region, such as `us-east-1` |
| `TOOLSTACK_WASABI_ACCESS_KEY` | Key limited to that bucket's `packages/*` objects |
| `TOOLSTACK_WASABI_SECRET_KEY` | Matching secret |
| `TOOLSTACK_CONTENT_KEY` | 32 random bytes encoded as 64 hexadecimal characters |

Keep the encryption key in secure backup with the deployment credentials. Replacing
it makes existing files unreadable. Keep Postgres and its volume backups; Wasabi
alone cannot reconstruct ownership or versions. Rotation needs an explicit data
migration. The provisioned database uses the restricted `toolstack_app` role.

Limits per person are 1,000 packages, 2,000 stored files and 2 GiB of file bytes.
A version has at most 100 files; a package retains up to 10,000 versions.
Instructions allow 200,000 characters and files allow 16 MiB each. Published
history retains its bytes. File transfers admit two operations at once; HTTP
library routes admit four requests before body parsing. Busy requests return 429.

Uploads stage metadata before storing bytes and publish both transactionally.
An uncertain database commit retains the object so a retry can recover it.
`npm run cleanup:library -w api` removes at most ten unpublished uploads older
than 24 hours. It uses central configuration and has no background timer.
Archive packages to withdraw access; permanent erasure and retention controls
require a separate implementation.

The operator scripts `provision:library` and `verify:cloud-library` default to
dry-run. Their `--apply` mode targets the dedicated Toolstack resources described
in [deployment](DEPLOYMENT.md). They read private operator configuration and print
no keys. Cloud verification creates a temporary TLS database endpoint and private
fixtures, then removes them. It never reuses an existing public database endpoint.
Add `--hosted` to exercise the existing HTTPS service and dashboard with temporary
owned content, including MCP discovery, retry replay and file download checks.

## Verification

After building, run `npm run test:library -w api` for checks in a temporary local
Postgres cluster. Set `TOOLSTACK_POSTGRES_BIN` when the installed Postgres binaries
are elsewhere. An explicit `TOOLSTACK_TEST_DATABASE_URL` enables the same tests in
CI, using a unique schema removed afterward. Production URLs are excluded from
the local runner.

`npm run verify:library -w api` exercises the built UI in real Chrome against
temporary Postgres, an isolated gateway and fixture object storage. It covers
import/edit/upload/download, sharing across identities and revocation, history,
archive restoration and responsive layouts. Actual Wasabi encryption and cloud
database persistence use `verify:cloud-library`; a fixture run alone does not
establish those properties.

On 7 November 2026, the full API run passed 43 files with 481 tests and eight
skips. The separate Postgres checks passed all nine tests, and both local Chrome
application checks passed. Live cloud and HTTPS/MCP Library checks passed, including
restricted-role TLS access, encrypted file round trips, immutable saves and retry
replay, access refusal, and desktop/mobile rendering. Verification fixtures and
the temporary public database endpoint were removed. The owner worker also passed
fresh Chrome creation, authenticated CDP, navigation and release. Team gateway
acceptance with real separate people remains open.

The post-release retained-login checks passed on Newspapers.com and Fold3.
Ancestry initially returned a human-verification interstitial; the existing
native handler cleared its checkbox, and the member-page check then passed.
No passwords were submitted. Each verification session was released.
