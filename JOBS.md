# Durable jobs

Toolstack uses pg-boss 12.38.1 and its existing Postgres for durable job delivery.
A dedicated organization executor handles work separately from the browser
service. Closing a tab or restarting the API leaves queued work in Postgres.

The first registered operation is `library_export`. It exports an exact saved
version of an owned Library package as a ZIP containing `SKILL.md`, `package.json`
and the selected supporting files with their original names and checksums.
Exporting does not run uploaded code or make provider requests. Further execution
runtimes require explicit server registration and their own permission checks.

## Use

Open an owned package in Library, save any edits and choose **Export saved
version**. Jobs shows its progress and provides cancellation and the completed
download. Refreshing or leaving the app preserves the job address. Results stay
private and expire after seven days; **Remove result** withdraws the download
and schedules encrypted-byte cleanup without changing the Library source.

The MCP tools are `jobs_submit`, `jobs_list`, `jobs_get`, `jobs_cancel`,
`jobs_result` and `jobs_remove_result`. Discover their schemas through the existing
catalog. `jobs_result` returns an authenticated download resource and checksum.

| REST endpoint | Operation |
| --- | --- |
| `POST /v1/jobs` | Submit `{requestId, type: "library_export", packageId, version}`; returns 202 and a job address |
| `GET /v1/jobs?limit=20&offset=0` | List the current member's jobs and executor availability |
| `GET /v1/jobs/:id` | Read progress, attempts, status and result availability |
| `POST /v1/jobs/:id/cancel` | Cancel queued, running or retrying work |
| `GET /v1/jobs/:id/result` | Download the verified ZIP; HEAD returns its metadata |
| `DELETE /v1/jobs/:id/result` | Withdraw a completed result |

Reuse the UUID `requestId` with the same package and version after a transport
failure. Job creation and pg-boss delivery commit in one database transaction.
Reusing it with different inputs returns 409. Cancellation is idempotent and
leaves completed jobs unchanged.

## Privacy and recovery

Every job and artifact carries the organization and owner membership. The queue
payload holds only the job ID. Instructions, scripts, API keys and browser
cookies stay out of queue messages. The job record stores a digest of its
originating Toolstack credential; removing that credential stops its queued work.

The executor checks live authorization before work, during execution and before
publishing. It rechecks source ownership; downloads recheck the requesting
member's access and verify the result checksum. An executor control credential
works only on its organization-bound authorization endpoint and grants no
browser, vault or general API access.

The executor has no personal vault key, browser API key, residential proxy
credentials, Chrome process or persistent worker volume. It is a trusted
organization data service with scoped Postgres and Wasabi access. Personal
browser workers receive none of those storage credentials.

Queue leases and heartbeats recover interrupted attempts. Attempt tokens prevent
an old executor from publishing over a newer attempt. Package exports are safe
to repeat, so temporary storage failures receive up to two retries with backoff.
Future operations with external effects need their own durable reconciliation;
a queue retry does not establish whether a provider action already happened.

Results use the Library's AES-256-GCM object format under
`packages/<org>/jobs/<job>/<artifact>`. Pending attempt records preserve recovery
after an uncertain commit. Maintenance removes unpublished attempts after one
day, expired results after seven days and finished metadata after thirty days.
Each pass processes at most ten artifacts and retries transient storage failures.

The executor processes one job at a time. Limits are five unfinished jobs per
member, fifty per organization, one thousand submissions per member per day,
16 MiB per export and 2 GiB or one thousand saved artifacts per member. Pending
attempts count toward storage limits. A run has a five-minute execution budget.

## Deployment

`node api/scripts/configure-jobs.mjs` previews provisioning. Its authorized
`--apply` mode takes pre-release database and owner-volume backups, prepares
the dedicated `toolstack_queue` schema, stages a private `Toolstack jobs` service
and adds the owner service's job configuration. It preserves existing browser
settings and removes its temporary TLS database endpoint before completion.

The current producer supports the sole-tenant standalone organization service.
Gateway/private-worker team rollout must move these organization job routes and
live authorization to the organization data service. Do not copy the central
database or content key into personal workers.

| Service | Configuration |
| --- | --- |
| Existing owner API | `TOOLSTACK_JOBS_ENABLED=true`, a dedicated `TOOLSTACK_JOBS_WORKER_KEY` and its existing central storage configuration |
| Dedicated executor | `STEEL_ROLE=executor`, `STEEL_IMAGE=jobs`, the same organization storage configuration and control key, plus `TOOLSTACK_JOBS_ORIGIN` pointing to its organization API |

Deploy the producer first, then the executor. The `jobs` image omits browser and
display dependencies, runs as `node` and limits the Node heap to 256 MiB. Railway
allocates one replica, one vCPU and 512 MiB. It needs no public domain; `/health`
reports readiness. Stop the executor to pause consumption while retaining queued
jobs. Keep both the app tables and queue schema in database backups, along with
the existing encryption key and private Wasabi objects.

## Verification

`npm run test:jobs -w api` uses a temporary local Postgres cluster. It covers
atomic submission, retry identity, organization/member denial, producer restart,
Unicode ZIP contents, cancellation, revocation, transient storage recovery and
recovery after an executor is killed. It does not use a production database.

`npm run verify:library -w api` exercises job submission, page reload,
cancellation, progress, download, result removal and responsive layouts in real
Chrome, alongside the Library checks. Hosted acceptance additionally exercises
the separate deployed executor and actual encrypted Wasabi results.
