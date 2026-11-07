// Organization-bound durable delivery. Queue rows contain references, never
// credentials or package bodies. Only registered, repeat-safe operations run.
import { createHash, randomUUID } from "node:crypto";
import { PgBoss, type Db, type JobWithMetadata } from "pg-boss";
import { ZipArchive } from "archiver";
import { z } from "zod";
import { PublicError } from "../../utils/public-error.js";
import { assertOrganizationMember, currentOrganization } from "../organization.js";
import { maxFileBytes, type LibraryActor, type LibraryService } from "../library/contracts.js";
import type { LibraryDatabase } from "../library/database.js";
import type { LibraryObjects } from "../library/objects.js";
import { jobsQuery, submitJob, type JobAuthorization, type Jobs } from "./contracts.js";

const missing = () => new PublicError("job_unavailable", "Job is unavailable", 404);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const adapter = (sql: any): Db => ({
  executeSql: async (query, values = []) => {
    const result = await sql.unsafe(query, values);
    // postgres.js returns a result array per statement in a batch. pg-boss
    // requires rows from every statement, including maintenance lock claims.
    return { rows: Array.isArray(result[0]) ? result.flat() : result };
  },
});
const terminal = new Set(["completed", "failed", "cancelled"]);

export class JobService implements Jobs {
  readonly boss: PgBoss;
  readonly ready: Promise<void>;
  readonly organization = currentOrganization();
  readonly queue = `toolstack-${this.organization.id}`;
  private maintenance?: ReturnType<typeof setInterval>;
  private maintaining = false;
  constructor(
    readonly sql: LibraryDatabase,
    private readonly library: LibraryService,
    private readonly objects: LibraryObjects,
    private readonly authorize: (row: any) => Promise<boolean>,
    options: { schema?: string; supervise?: boolean } = {},
  ) {
    this.boss = new PgBoss({
      db: adapter(sql),
      schema: options.schema ?? "toolstack_queue",
      schedule: false,
      supervise: options.supervise ?? false,
      superviseIntervalSeconds: 10,
      monitorIntervalSeconds: 10,
      maintenanceIntervalSeconds: 60,
      registerInstance: false,
      createSchema: false,
    });
    // Database/provider errors can contain private values. Their public failure
    // is availability; emit no raw objects, queue payloads or SQL parameters.
    this.boss.on("error", () => console.error("Job queue temporarily unavailable"));
    this.ready = this.initialize();
    void this.ready.catch(() => undefined);
  }
  private async initialize() {
    await this.library.ready;
    const [organization] = await this.sql`SELECT id FROM toolstack_organizations`;
    if (organization?.id !== this.organization.id)
      throw new Error("Job database organization mismatch");
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(761933004622)`;
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS toolstack_jobs (
        id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES toolstack_organizations(id),
        owner_membership_id uuid NOT NULL, user_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
        type text NOT NULL CHECK(type='library_export'), runtime_version integer NOT NULL DEFAULT 1 CHECK(runtime_version=1),
        source_id uuid NOT NULL, source_version integer NOT NULL, title text NOT NULL, auth_binding jsonb NOT NULL,
        state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retrying','completed','failed','cancelled')),
        progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), stage text NOT NULL DEFAULT 'Waiting for a worker',
        attempt_no integer NOT NULL DEFAULT -1, attempt_token uuid, result_id uuid, result_expires_at timestamptz, error text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
        UNIQUE(org_id,id,owner_membership_id), UNIQUE(org_id,owner_membership_id,request_id),
        FOREIGN KEY(org_id,owner_membership_id) REFERENCES toolstack_memberships(org_id,id),
        FOREIGN KEY(org_id,source_id,owner_membership_id) REFERENCES toolstack_packages(org_id,id,owner_membership_id),
        FOREIGN KEY(source_id,source_version) REFERENCES toolstack_package_versions(package_id,version));
        CREATE INDEX IF NOT EXISTS toolstack_jobs_owner ON toolstack_jobs(org_id,owner_membership_id,created_at DESC,id);
        CREATE TABLE IF NOT EXISTS toolstack_job_artifacts (
          id uuid PRIMARY KEY, org_id uuid NOT NULL, job_id uuid NOT NULL, owner_membership_id uuid NOT NULL,
          object_key text NOT NULL UNIQUE, name text NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 16777216), sha256 text NOT NULL,
          state text NOT NULL CHECK(state IN ('pending','ready')), created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
          FOREIGN KEY(org_id,job_id,owner_membership_id) REFERENCES toolstack_jobs(org_id,id,owner_membership_id));
        CREATE TABLE IF NOT EXISTS toolstack_job_runtime (
          org_id uuid PRIMARY KEY REFERENCES toolstack_organizations(id), last_seen timestamptz NOT NULL);
        `);
    });
    await this.boss.start();
    await this.boss.createQueue(this.queue, {
      policy: "singleton",
      retryLimit: 2,
      retryDelay: 3,
      retryBackoff: true,
      expireInSeconds: 360,
      heartbeatSeconds: 20,
      retentionSeconds: 86400 * 7,
      deleteAfterSeconds: 86400 * 7,
    });
  }
  private async row(actor: LibraryActor, id: string) {
    assertOrganizationMember(actor, this.organization);
    await this.ready;
    const [row] = await this
      .sql`SELECT * FROM toolstack_jobs WHERE id=${z.string().uuid().parse(id)}
      AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} AND user_id=${actor.userId}`;
    if (!row) throw missing();
    return row;
  }
  private summary(row: any) {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      state: row.state,
      progress: row.progress,
      stage: row.stage,
      attempts: row.attempt_no + 1,
      error: row.error,
      packageId: row.source_id,
      version: row.source_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      resultAvailable:
        row.state === "completed" &&
        !!row.result_id &&
        new Date(row.result_expires_at).getTime() > Date.now(),
    };
  }
  async list(actor: LibraryActor, query: unknown = {}) {
    assertOrganizationMember(actor, this.organization);
    await this.ready;
    const input = jobsQuery.parse(query);
    const rows = await this.sql`SELECT *,count(*) OVER()::integer AS total FROM toolstack_jobs
      WHERE org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} AND user_id=${actor.userId}
      ORDER BY created_at DESC,id LIMIT ${input.limit} OFFSET ${input.offset}`;
    const [runtime] = await this
      .sql`SELECT last_seen>now()-interval '45 seconds' AS ready FROM toolstack_job_runtime WHERE org_id=${actor.orgId}`;
    return {
      jobs: rows.map((row) => this.summary(row)),
      total: rows[0]?.total ?? 0,
      workerAvailable: runtime?.ready === true,
      nextOffset:
        rows.length && input.offset + rows.length < rows[0].total
          ? input.offset + rows.length
          : null,
    };
  }
  async get(actor: LibraryActor, id: string) {
    return this.summary(await this.row(actor, id));
  }
  private async source(row: any) {
    const actor = { orgId: row.org_id, membershipId: row.owner_membership_id, userId: row.user_id };
    const source = await this.library.call(actor, {
      action: "get",
      id: row.source_id,
      version: row.source_version,
    });
    if (!source.canEdit) throw missing();
    return source;
  }
  async submit(actor: LibraryActor, value: unknown, authorization: JobAuthorization) {
    assertOrganizationMember(actor, this.organization);
    await this.ready;
    const input = submitJob.parse(value);
    const keyHash = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(authorization.keyHash);
    const source = await this.library.call(actor, {
      action: "get",
      id: input.packageId,
      version: input.version,
    });
    if (!source.canEdit) throw missing();
    const fingerprint = hash(JSON.stringify([input.type, input.packageId, input.version]));
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(761933004623)`;
      const [previous] =
        await tx`SELECT id,request_hash FROM toolstack_jobs WHERE org_id=${actor.orgId}
        AND owner_membership_id=${actor.membershipId} AND request_id=${input.requestId}`;
      if (previous) {
        if (previous.request_hash !== fingerprint)
          throw new PublicError(
            "request_conflict",
            "This request ID was used for another job",
            409,
          );
        return previous.id;
      }
      const [limits] =
        await tx`SELECT count(*) FILTER(WHERE state IN ('queued','running','retrying'))::integer AS active,
        count(*) FILTER(WHERE owner_membership_id=${actor.membershipId} AND state IN ('queued','running','retrying'))::integer AS personal,
        count(*) FILTER(WHERE owner_membership_id=${actor.membershipId} AND created_at>now()-interval '1 day')::integer AS daily
        FROM toolstack_jobs WHERE org_id=${actor.orgId}`;
      if (limits.active >= 50 || limits.personal >= 5 || limits.daily >= 1000)
        throw new PublicError(
          "jobs_busy",
          "Your job allowance is full. Wait for a job to finish.",
          429,
        );
      const id = randomUUID();
      await tx`INSERT INTO toolstack_jobs(id,org_id,owner_membership_id,user_id,request_id,request_hash,type,source_id,source_version,title,auth_binding)
        VALUES(${id},${actor.orgId},${actor.membershipId},${actor.userId},${input.requestId},${fingerprint},${input.type},${input.packageId},${input.version},${source.title},${tx.json({ keyHash })})`;
      const sent = await this.boss.send(this.queue, { id }, { id, db: adapter(tx) });
      if (sent !== id) throw new Error("Job delivery was not committed");
      return id;
    });
    return this.get(actor, id);
  }
  async cancel(actor: LibraryActor, id: string) {
    await this.row(actor, id);
    await this.sql.begin(async (tx) => {
      const changed =
        await tx`UPDATE toolstack_jobs SET state='cancelled',stage='Cancelled',error=NULL,finished_at=now(),updated_at=now()
        WHERE id=${id} AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} AND state IN ('queued','running','retrying') RETURNING id`;
      if (changed.length) await this.boss.cancel(this.queue, id, { db: adapter(tx) });
    });
    return this.get(actor, id);
  }
  async authorizeWork(id: string) {
    await this.ready;
    const [row] = await this
      .sql`SELECT * FROM toolstack_jobs WHERE id=${z.string().uuid().parse(id)} AND org_id=${this.organization.id}`;
    if (!row || terminal.has(row.state) || !(await this.authorize(row))) return false;
    try {
      await this.source(row);
      return true;
    } catch (error) {
      if (error instanceof PublicError) return false;
      throw error;
    }
  }
  private async result(actor: LibraryActor, id: string) {
    const row = await this.row(actor, id);
    await this.source(row);
    if (row.state !== "completed" || !row.result_id) throw missing();
    const [file] = await this
      .sql`SELECT * FROM toolstack_job_artifacts WHERE id=${row.result_id} AND org_id=${actor.orgId}
      AND job_id=${id} AND owner_membership_id=${actor.membershipId} AND state='ready' AND expires_at>now()`;
    if (!file)
      throw new PublicError(
        "result_expired",
        "This result has expired. Start another export.",
        410,
      );
    return { row, file };
  }
  async resultInfo(actor: LibraryActor, id: string) {
    const { file } = await this.result(actor, id);
    return { name: file.name, bytes: Number(file.bytes), sha256: file.sha256 };
  }
  async download(actor: LibraryActor, id: string) {
    const { row, file } = await this.result(actor, id);
    const bytes = await this.objects.get(file.object_key);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("Job result verification failed");
    await this.source(row);
    return { name: file.name, bytes, sha256: file.sha256 };
  }
  async removeResult(actor: LibraryActor, id: string) {
    const row = await this.row(actor, id);
    if (!row.result_id) return this.summary(row);
    await this.sql.begin(async (tx) => {
      await tx`UPDATE toolstack_jobs SET result_id=NULL,result_expires_at=NULL,stage='Result removed',updated_at=now()
        WHERE id=${id} AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId}`;
      await tx`UPDATE toolstack_job_artifacts SET expires_at=now()-interval '1 second'
        WHERE id=${row.result_id} AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId}`;
    });
    // Access ends transactionally. The executor's retention pass retries byte
    // removal if storage is temporarily unavailable.
    return this.get(actor, id);
  }
  async work() {
    await this.ready;
    await this.boss.work<
      { id: string },
      void,
      {
        includeMetadata: true;
        batchSize: number;
        localConcurrency: number;
        pollingIntervalSeconds: number;
      }
    >(
      this.queue,
      { includeMetadata: true, batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await this.execute(job);
      },
    );
    const maintain = async () => {
      if (this.maintaining) return;
      this.maintaining = true;
      try {
        await this
          .sql`INSERT INTO toolstack_job_runtime(org_id,last_seen) VALUES(${this.organization.id},now())
          ON CONFLICT(org_id) DO UPDATE SET last_seen=now()`;
        await this.prune();
      } catch {
        console.error("Job maintenance temporarily unavailable");
      } finally {
        this.maintaining = false;
      }
    };
    await maintain();
    this.maintenance = setInterval(() => void maintain(), 15000);
    this.maintenance.unref();
  }
  private async execute(job: JobWithMetadata<{ id: string }>) {
    if (job.data.id !== job.id) return;
    const token = randomUUID();
    const [row] = await this
      .sql`UPDATE toolstack_jobs SET state='running',attempt_no=${job.retryCount},attempt_token=${token},
      stage='Preparing package',progress=0,error=NULL,updated_at=now() WHERE id=${job.id} AND org_id=${this.organization.id}
      AND state IN ('queued','running','retrying') AND attempt_no<${job.retryCount} RETURNING *`;
    if (!row) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, job.signal, AbortSignal.timeout(300000)]);
    let checking: Promise<void> | undefined;
    const checkpoint = () => {
      signal.throwIfAborted();
      return (checking ??= (async () => {
        const [current] = await this
          .sql`SELECT state,attempt_token FROM toolstack_jobs WHERE id=${job.id} AND org_id=${this.organization.id}`;
        if (
          current?.state !== "running" ||
          current.attempt_token !== token ||
          !(await this.authorize(row))
        )
          throw new PublicError("job_stopped", "Job access ended or the job was cancelled", 403);
        signal.throwIfAborted();
      })().finally(() => {
        checking = undefined;
      }));
    };
    const progress = async (value: number, stage: string) => {
      await checkpoint();
      await this
        .sql`UPDATE toolstack_jobs SET progress=${value},stage=${stage},updated_at=now() WHERE id=${job.id}
        AND org_id=${this.organization.id} AND state='running' AND attempt_token=${token}`;
    };
    const watcher = setInterval(
      () => void checkpoint().catch((error) => controller.abort(error)),
      2000,
    );
    watcher.unref();
    try {
      await checkpoint();
      const source = await this.source(row);
      const bytes = await this.bundle(row, source, signal, progress);
      await progress(95, "Verifying saved result");
      const artifactId = randomUUID(),
        name = `package-${row.source_id}-v${row.source_version}.zip`;
      const artifact = `packages/${row.org_id}/jobs/${job.id}/${artifactId}`;
      await this.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(761933004623)`;
        const [usage] =
          await tx`SELECT COALESCE(sum(bytes),0)::bigint AS bytes,count(*)::integer AS files
          FROM toolstack_job_artifacts WHERE org_id=${row.org_id} AND owner_membership_id=${row.owner_membership_id}`;
        if (Number(usage.bytes) + bytes.length > 2 * 1024 ** 3 || usage.files >= 1000)
          throw new PublicError(
            "result_quota",
            "Your saved results are full. Remove an older result before exporting again.",
            429,
          );
        await tx`INSERT INTO toolstack_job_artifacts(id,org_id,job_id,owner_membership_id,object_key,name,bytes,sha256,state)
          VALUES(${artifactId},${row.org_id},${job.id},${row.owner_membership_id},${artifact},${name},${bytes.length},${hash(bytes)},'pending')`;
      });
      await this.objects.put(artifact, bytes);
      const saved = await this.objects.get(artifact);
      if (saved.length !== bytes.length || hash(saved) !== hash(bytes))
        throw new Error("Job artifact verification failed");
      await checkpoint();
      await this.source(row);
      await this.sql.begin(async (tx) => {
        const published =
          await tx`UPDATE toolstack_jobs SET state='completed',progress=100,stage='Ready to download',result_id=${artifactId},result_expires_at=(SELECT expires_at FROM toolstack_job_artifacts WHERE id=${artifactId}),finished_at=now(),updated_at=now()
          WHERE id=${job.id} AND org_id=${row.org_id} AND state='running' AND attempt_token=${token} RETURNING id`;
        if (published.length)
          await tx`UPDATE toolstack_job_artifacts SET state='ready' WHERE id=${artifactId}`;
      });
    } catch (error) {
      // Every registered operation here is read-only plus attempt-scoped object
      // writes. Retrying it cannot submit a provider action or repeat a charge.
      const stopped = error instanceof PublicError;
      const retry = !stopped && job.retryCount < job.retryLimit;
      await this.sql`UPDATE toolstack_jobs SET state=${retry ? "retrying" : "failed"},
        stage=${retry ? "Waiting to retry" : "Export stopped"},error=${stopped ? (["export_too_large", "result_quota"].includes(error.code) ? error.message : "Access ended. Start a new job after reconnecting.") : retry ? "Storage is temporarily unavailable. Retrying automatically." : "The export could not finish. Start a new job to retry."},
        updated_at=now(),finished_at=${retry ? null : new Date()} WHERE id=${job.id} AND org_id=${row.org_id} AND state='running' AND attempt_token=${token}`;
      if (retry) throw new Error("Export attempt temporarily unavailable");
    } finally {
      clearInterval(watcher);
      // Pending artifacts are retained after uncertain commits. Maintenance
      // removes only unreferenced/expired records after their recovery window.
    }
  }
  private async bundle(
    row: any,
    source: any,
    signal: AbortSignal,
    progress: (n: number, s: string) => Promise<void>,
  ) {
    const total = source.files.reduce(
      (n: number, file: any) => n + file.bytes,
      Buffer.byteLength(source.instructions),
    );
    if (total > maxFileBytes - 100000)
      throw new PublicError(
        "export_too_large",
        "This package exceeds the 16 MiB export limit",
        413,
      );
    const archive = new ZipArchive({ zlib: { level: 6 } }),
      chunks: Buffer[] = [];
    let size = 0;
    const done = new Promise<Buffer>((resolve, reject) => {
      archive.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxFileBytes) {
          archive.abort();
          reject(new PublicError("export_too_large", "This export exceeds 16 MiB", 413));
        } else chunks.push(Buffer.from(chunk));
      });
      archive.once("error", reject);
      archive.once("end", () => resolve(Buffer.concat(chunks)));
      signal.addEventListener(
        "abort",
        () => {
          archive.abort();
          reject(signal.reason);
        },
        { once: true },
      );
    });
    // Attach immediately so an abort during a file fetch is handled.
    void done.catch(() => undefined);
    try {
      archive.append(source.instructions, { name: "SKILL.md" });
      const manifest = {
        format: "toolstack-package-v1",
        id: source.id,
        version: source.version,
        title: source.title,
        description: source.description,
        kind: source.kind,
        runtime: source.runtime,
        files: source.files.map((file: any) => ({
          ...file,
          path: `files/${file.id}/${file.name}`,
        })),
      };
      archive.append(JSON.stringify(manifest, null, 2) + "\n", { name: "package.json" });
      for (let i = 0; i < source.files.length; i++) {
        signal.throwIfAborted();
        const file = source.files[i];
        if (!file.name || /[\/\\\x00-\x1f\x7f]/.test(file.name) || [".", ".."].includes(file.name))
          throw new Error("Invalid source filename");
        await progress(
          Math.floor(5 + (85 * i) / Math.max(1, source.files.length)),
          `Packaging file ${i + 1} of ${source.files.length}`,
        );
        const value = await this.library.call(
          { orgId: row.org_id, membershipId: row.owner_membership_id, userId: row.user_id },
          { action: "file", id: row.source_id, input: { file: file.id } },
        );
        const bytes = Buffer.from(value.base64, "base64");
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
          throw new Error("Source file verification failed");
        archive.append(bytes, { name: `files/${file.id}/${file.name}` });
      }
      signal.throwIfAborted();
      await archive.finalize();
      return await done;
    } catch (error) {
      archive.abort();
      throw error;
    }
  }
  async prune() {
    await this.ready;
    const stale = await this.sql`SELECT id FROM toolstack_jobs WHERE org_id=${this.organization.id}
      AND state IN ('queued','running','retrying') AND updated_at<now()-interval '1 minute' ORDER BY updated_at LIMIT 10`;
    for (const row of stale) {
      const [delivery] = await this.boss.findJobs(this.queue, { id: row.id });
      if (!delivery || ["failed", "cancelled"].includes(delivery.state))
        await this
          .sql`UPDATE toolstack_jobs SET state='failed',stage='Worker could not finish',error='Start a new export to retry.',finished_at=now(),updated_at=now()
          WHERE id=${row.id} AND org_id=${this.organization.id} AND state IN ('queued','running','retrying')`;
    }
    const files = await this
      .sql`SELECT * FROM toolstack_job_artifacts WHERE org_id=${this.organization.id}
      AND (expires_at<now() OR (state='pending' AND created_at<now()-interval '1 day')) ORDER BY created_at LIMIT 10`;
    for (const file of files) {
      await this.objects.remove(file.object_key);
      await this.sql.begin(async (tx) => {
        await tx`UPDATE toolstack_jobs SET result_id=NULL WHERE org_id=${this.organization.id} AND result_id=${file.id}`;
        await tx`DELETE FROM toolstack_job_artifacts WHERE id=${file.id} AND org_id=${this.organization.id}`;
      });
    }
    await this
      .sql`DELETE FROM toolstack_jobs j WHERE org_id=${this.organization.id} AND created_at<now()-interval '30 days'
      AND state IN ('completed','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM toolstack_job_artifacts f WHERE f.job_id=j.id)`;
  }
  async close() {
    if (this.maintenance) clearInterval(this.maintenance);
    await this.boss.stop({ graceful: true, timeout: 20000 });
    this.objects.close();
  }
}
