import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContentLibrary } from "../library/library.js";
import type { LibraryObjects } from "../library/objects.js";
import { organizationMember } from "../organization.js";
import { JobService } from "./service.js";
import { jobWorkerAuthorized } from "./access.js";
import type { IncomingMessage } from "node:http";

const url = process.env.TOOLSTACK_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const admin = url ? postgres(url, { max: 2, onnotice: () => {} }) : undefined;
let sql: ReturnType<typeof postgres>, library: ContentLibrary, jobs: JobService;
let schema: string, queueSchema: string, authorized: boolean;
const data = new Map<string, Buffer>();
let objects: LibraryObjects;
const owner = organizationMember("alice"),
  bob = organizationMember("bob");
const authorization = { keyHash: "a".repeat(64) };
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const services: JobService[] = [];
const create = () =>
  library.call(owner, {
    action: "create",
    input: {
      requestId: randomUUID(),
      title: "Export fixture",
      instructions: "Private instructions",
    },
  });
const submit = (p: any, requestId = randomUUID()) =>
  jobs.submit(
    owner,
    { requestId, type: "library_export", packageId: p.id, version: p.version },
    authorization,
  );
async function until<T>(run: () => Promise<T>, accept: (value: T) => boolean, ms = 15000) {
  const end = Date.now() + ms;
  let value: T;
  do {
    value = await run();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 80));
  } while (Date.now() < end);
  throw Error("Expected job state did not arrive");
}
const service = () => {
  const result = new JobService(sql, library, objects, async () => authorized, {
    schema: queueSchema,
    supervise: true,
  });
  result.boss.on("error", (error) =>
    console.error("Fixture queue diagnostic", {
      name: error.name,
      code: (error as any).code,
      message: error.message
        .replace(/postgres(?:ql)?:\/\/\S+/g, "[fixture database]")
        .slice(0, 500),
    }),
  );
  services.push(result);
  return result;
};
beforeEach(async () => {
  if (!admin || !url) return;
  authorized = true;
  data.clear();
  const suffix = randomUUID().replaceAll("-", "");
  schema = `test_jobs_${suffix}`;
  queueSchema = `test_queue_${suffix}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await admin`CREATE SCHEMA ${admin(queueSchema)}`;
  sql = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: schema } });
  objects = {
    put: async (key, value) => {
      data.set(key, Buffer.from(value));
    },
    get: async (key) => Buffer.from(data.get(key)!),
    remove: async (key) => {
      data.delete(key);
    },
    close: () => {},
  };
  library = new ContentLibrary(sql, objects);
  await library.ready;
  jobs = service();
  await jobs.ready;
});
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  if (library) await library.close();
  if (admin && schema) {
    await admin`DROP SCHEMA ${admin(queueSchema)} CASCADE`;
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await admin?.end({ timeout: 2 });
});

test("an executor credential grants no browser access and cannot select a foreign organization", () => {
  vi.stubEnv("TOOLSTACK_JOBS_WORKER_KEY", "fixture-executor-".repeat(4));
  const req = {
    method: "POST",
    url: `/internal/jobs/${randomUUID()}/authorize`,
    headers: {
      authorization: `Bearer ${process.env.TOOLSTACK_JOBS_WORKER_KEY}`,
      "x-toolstack-org-id": owner.orgId,
    },
  } as unknown as IncomingMessage;
  expect(jobWorkerAuthorized(req)).toBe(true);
  req.url = "/v1/vault";
  expect(jobWorkerAuthorized(req)).toBe(false);
  req.url = `/internal/jobs/${randomUUID()}/authorize`;
  req.headers["x-toolstack-org-id"] = randomUUID();
  expect(jobWorkerAuthorized(req)).toBe(false);
});

dbTest("submission is atomic, retry-safe and private to its organization membership", async () => {
  const batch = await jobs.boss.getDb().executeSql("SELECT 1 AS one; SELECT 2 AS two");
  expect(batch.rows).toEqual([{ one: 1 }, { two: 2 }]);
  await jobs.boss.supervise(jobs.queue);
  const p = await create(),
    requestId = randomUUID();
  const [a, b] = await Promise.all([submit(p, requestId), submit(p, requestId)]);
  expect(a.id).toBe(b.id);
  expect((await jobs.list(bob)).jobs).toEqual([]);
  await expect(jobs.get(bob, a.id)).rejects.toThrow("unavailable");
  await expect(jobs.get({ ...owner, orgId: randomUUID() }, a.id)).rejects.toThrow("unavailable");
  await expect(jobs.get({ ...owner, membershipId: randomUUID() }, a.id)).rejects.toThrow(
    "unavailable",
  );
  const next = await library.call(owner, {
    action: "update",
    id: p.id,
    input: {
      requestId: randomUUID(),
      expectedVersion: p.version,
      title: p.title,
      instructions: "New revision",
      files: [],
    },
  });
  await expect(submit(next, requestId)).rejects.toThrow("another job");
  const failedRequest = randomUUID();
  vi.spyOn(jobs.boss, "send").mockRejectedValueOnce(Error("fixture enqueue failure"));
  await expect(submit(p, failedRequest)).rejects.toThrow("fixture enqueue failure");
  expect(await sql`SELECT id FROM toolstack_jobs WHERE request_id=${failedRequest}`).toHaveLength(
    0,
  );
  expect(JSON.stringify(a)).not.toMatch(/authorization|object_key|keyHash/);
});

dbTest(
  "an exact saved version survives producer restart and produces a verified Unicode ZIP",
  async () => {
    let p = await create();
    p = await library.call(owner, {
      action: "upload",
      id: p.id,
      input: {
        requestId: randomUUID(),
        expectedVersion: p.version,
        name: "café 'check'.py",
        role: "script",
        mediaType: "text/x-python",
        base64: Buffer.from("print('fixture')\n").toString("base64"),
      },
    });
    const submitted = await submit(p);
    await jobs.close();
    services.splice(services.indexOf(jobs), 1);
    jobs = service();
    await jobs.work();
    const completed = await until(
      () => jobs.get(owner, submitted.id),
      (job) => job.state === "completed",
    );
    expect(completed.version).toBe(p.version);
    const reads = vi.spyOn(objects, "get");
    const info = await jobs.resultInfo(owner, submitted.id);
    expect(reads).not.toHaveBeenCalled();
    const result = await jobs.download(owner, submitted.id);
    expect(info.sha256).toBe(result.sha256);
    expect(info.bytes).toBe(result.bytes.length);
    expect(digest(result.bytes)).toBe(result.sha256);
    const check = spawnSync(
      "python3",
      [
        "-c",
        "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); m=json.loads(z.read('package.json')); print(json.dumps({'instructions':z.read('SKILL.md').decode(),'file':z.read(m['files'][0]['path']).decode(),'name':m['files'][0]['name']}))",
      ],
      { input: result.bytes },
    );
    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout.toString())).toEqual({
      instructions: "Private instructions",
      file: "print('fixture')\n",
      name: "café 'check'.py",
    });
    await expect(jobs.download(bob, submitted.id)).rejects.toThrow("unavailable");
    await sql`UPDATE toolstack_job_artifacts SET expires_at=now()-interval '1 second' WHERE job_id=${submitted.id}`;
    await expect(jobs.download(owner, submitted.id)).rejects.toThrow("expired");
    await jobs.prune();
    expect((await jobs.get(owner, submitted.id)).resultAvailable).toBe(false);
    expect(data.has([...data.keys()].find((key) => key.includes("/jobs/")) ?? "")).toBe(false);
  },
);

dbTest("cancelled queued work does not run and revoked submissions cannot publish", async () => {
  const p = await create(),
    cancelled = await submit(p);
  await jobs.cancel(owner, cancelled.id);
  authorized = false;
  const revoked = await submit(p);
  await jobs.work();
  const failure = await until(
    () => jobs.get(owner, revoked.id),
    (job) => job.state === "failed",
  );
  expect(failure.resultAvailable).toBe(false);
  expect((await jobs.get(owner, cancelled.id)).state).toBe("cancelled");
  expect(await sql`SELECT id FROM toolstack_job_artifacts`).toHaveLength(0);
});

dbTest(
  "running cancellation suppresses publication and retryable storage errors recover",
  async () => {
    const p = await create(),
      submitted = await submit(p);
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const original = objects.put;
    objects.put = async (key, bytes) => {
      if (key.includes("/jobs/")) await hold;
      await original(key, bytes);
    };
    await jobs.work();
    await until(
      () => jobs.get(owner, submitted.id),
      (job) => job.progress === 95,
    );
    await jobs.cancel(owner, submitted.id);
    release();
    await until(
      async () => jobs.boss.getWipData(),
      (value) => value.every((worker) => worker.count === 0),
    );
    expect((await jobs.get(owner, submitted.id)).state).toBe("cancelled");
    await expect(jobs.download(owner, submitted.id)).rejects.toThrow("unavailable");
    let failed = false;
    objects.put = async (key, bytes) => {
      if (key.includes("/jobs/") && !failed) {
        failed = true;
        throw Error("fixture private provider diagnostic");
      }
      await original(key, bytes);
    };
    const retried = await submit(p);
    const completed = await until(
      () => jobs.get(owner, retried.id),
      (job) => job.state === "completed",
      20000,
    );
    expect(completed.attempts).toBe(2);
    expect(JSON.stringify(completed)).not.toContain("private provider");
    expect((await jobs.download(owner, retried.id)).bytes.length).toBeGreaterThan(0);
  },
);

dbTest(
  "a killed executor is recovered through its queue lease without losing the result",
  async () => {
    const p = await create(),
      submitted = await submit(p);
    const module = fileURLToPath(new URL("./service.ts", import.meta.url)),
      lib = fileURLToPath(new URL("../library/library.ts", import.meta.url));
    const code = `import postgres from 'postgres';import {JobService} from ${JSON.stringify(module)};import {ContentLibrary} from ${JSON.stringify(lib)};
 const sql=postgres(process.env.TOOLSTACK_TEST_DATABASE_URL,{max:4,onnotice:()=>{},connection:{search_path:process.env.JOB_TEST_SCHEMA}});
 const objects={put:async()=>{},get:async()=>Buffer.from(''),remove:async()=>{},close:()=>{}};
 const library=new ContentLibrary(sql,objects);await library.ready;
 const service=new JobService(sql,library,objects,async()=>{process.kill(process.pid,'SIGKILL');return false;},{schema:process.env.JOB_TEST_QUEUE,supervise:true});await service.work();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, JOB_TEST_SCHEMA: schema, JOB_TEST_QUEUE: queueSchema },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    const exited = await new Promise<string | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (_code, signal) => resolve(signal));
    }).finally(() => clearTimeout(timer));
    expect(timedOut, diagnostic).toBe(false);
    expect(exited, diagnostic).toBe("SIGKILL");
    expect((await jobs.get(owner, submitted.id)).state).toBe("running");
    await jobs.work();
    const recovered = await until(
      () => jobs.get(owner, submitted.id),
      (job) => job.state === "completed",
      65000,
    );
    expect(recovered.attempts).toBe(2);
    expect((await jobs.download(owner, submitted.id)).bytes.length).toBeGreaterThan(0);
  },
  90000,
);
