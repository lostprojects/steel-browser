// Uses a temporary schema in an explicitly supplied test database. It must not
// truncate or migrate the application's public schema or use its production URL.
import postgres from "postgres";
import { organizationMember, currentOrganization } from "../organization.js";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, beforeEach, expect, test, vi } from "vitest";
import { ContentLibrary } from "./library.js";
import type { LibraryObjects } from "./objects.js";
import { WasabiObjects } from "./objects.js";
import { libraryToolkit } from "../../modules/mcp/library.js";
import { ToolRegistry } from "../toolkits/registry.js";
import { migration } from "./database.js";

const url = process.env.TOOLSTACK_TEST_DATABASE_URL;
const databaseTest = url ? test : test.skip;
const schema = `toolstack_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const root = url ? postgres(url, { max: 2, onnotice: () => {} }) : undefined;
let library: ContentLibrary;
let sql: ReturnType<typeof postgres>;
const data = new Map<string, Buffer>();
const objects: LibraryObjects = {
  put: vi.fn(async (key, bytes) => {
    data.set(key, Buffer.from(bytes));
  }),
  get: vi.fn(async (key) => Buffer.from(data.get(key)!)),
  remove: vi.fn(async (key) => {
    data.delete(key);
  }),
  close: () => {},
};
const actor = organizationMember("alice"),
  bob = organizationMember("bob"),
  carol = organizationMember("carol");
const create = (instructions = "Private method") =>
  library.call(actor, {
    action: "create",
    input: { requestId: randomUUID(), title: "A skill", instructions },
  });
const share = (p: any, visibility: string, assignedTo: string[] = []) =>
  library.call(actor, {
    action: "share",
    id: p.id,
    input: { requestId: randomUUID(), expectedVersion: p.version, visibility, assignedTo },
  });
const update = (
  p: any,
  instructions: string,
  files: string[] = p.files.map((file: any) => file.id),
) =>
  library.call(actor, {
    action: "update",
    id: p.id,
    input: {
      requestId: randomUUID(),
      expectedVersion: p.version,
      title: p.title,
      instructions,
      files,
    },
  });
const upload = (p: any, requestId = randomUUID()) =>
  library.call(actor, {
    action: "upload",
    id: p.id,
    input: {
      requestId,
      expectedVersion: p.version,
      name: "helper.py",
      role: "script",
      mediaType: "text/x-python",
      base64: Buffer.from("print('fixture')\n").toString("base64"),
    },
  });

beforeAll(async () => {
  if (!root || !url) return;
  await root.unsafe(`CREATE SCHEMA ${schema}`);
  sql = postgres(url, {
    max: 4,
    onnotice: () => {},
    connection: { search_path: schema, statement_timeout: 10_000 },
  });
  library = new ContentLibrary(sql, objects);
  await library.ready;
});
beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE toolstack_content_files,toolstack_package_versions,toolstack_packages CASCADE`;
  data.clear();
  vi.clearAllMocks();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await library?.close();
  if (root) {
    await root.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end({ timeout: 2 });
  }
});

databaseTest(
  "private defaults and grants protect metadata, historical instructions and files",
  async () => {
    let p = await create("Earlier private instructions");
    const original = p.version;
    expect(p).toMatchObject({ owner: "alice", visibility: "private", files: [] });
    expect((await library.call(bob, { action: "list" })).packages).toEqual([]);
    await expect(library.call(bob, { action: "get", id: p.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    p = await upload(p);
    const file = p.files[0];
    expect(file.sha256).toBe(createHash("sha256").update("print('fixture')\n").digest("hex"));
    p = await update(p, "Shared current instructions");
    p = await share(p, "assigned", ["bob"]);
    const shared = await library.call(bob, { action: "get", id: p.id });
    expect(shared).not.toHaveProperty("assignedTo");
    expect(shared.instructions).toBe("Shared current instructions");
    await expect(
      library.call(bob, { action: "get", id: p.id, version: original }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await library.call(bob, { action: "file", id: p.id, input: { file: file.id } })).base64,
    ).toBe(Buffer.from("print('fixture')\n").toString("base64"));
    await expect(library.call(carol, { action: "get", id: p.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    p = await share(p, "global");
    expect((await library.call(carol, { action: "get", id: p.id })).canEdit).toBe(false);
    p = await share(p, "private");
    const reads = vi.mocked(objects.get).mock.calls.length;
    await expect(
      library.call(bob, { action: "file", id: p.id, input: { file: file.id } }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(vi.mocked(objects.get)).toHaveBeenCalledTimes(reads);
  },
);

databaseTest("transport retries and concurrent edits preserve one immutable result", async () => {
  const requestId = randomUUID(),
    input = { requestId, title: "Retry fixture", instructions: "Original" };
  const p = await library.call(actor, { action: "create", input });
  expect((await library.call(actor, { action: "create", input })).id).toBe(p.id);
  await expect(
    library.call(actor, { action: "create", input: { ...input, title: "Changed" } }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  const outcomes = await Promise.allSettled([update(p, "First edit"), update(p, "Second edit")]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await library.call(actor, { action: "history", id: p.id })).versions).toHaveLength(2);
  const retry = randomUUID(),
    current = await library.call(actor, { action: "get", id: p.id });
  const file = await upload(current, retry);
  expect((await upload(current, retry)).files).toEqual(file.files);
  expect(objects.put).toHaveBeenCalledTimes(1);
});

databaseTest(
  "removed files are owner-only and foreign file references cannot enter a version",
  async () => {
    let p = await upload(await create());
    const file = p.files[0];
    p = await share(p, "global");
    p = await update(p, "No file now", []);
    await expect(
      library.call(bob, { action: "file_info", id: p.id, input: { file: file.id } }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await library.call(actor, { action: "file_info", id: p.id, input: { file: file.id } })).name,
    ).toBe("helper.py");
    const other = await create();
    await expect(update(other, "Foreign attachment", [file.id])).rejects.toMatchObject({
      code: "invalid_content",
    });
    await expect(
      library.call(bob, {
        action: "share",
        id: p.id,
        input: { requestId: randomUUID(), expectedVersion: p.version, visibility: "private" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  },
);

databaseTest(
  "a lost response after publication cannot delete a committed object's bytes",
  async () => {
    const p = await create(),
      requestId = randomUUID();
    const original = (library as any).mutate.bind(library);
    const simulated = vi
      .spyOn(library as any, "mutate")
      .mockImplementationOnce(async (...args: unknown[]) => {
        await original(...args);
        throw new Error("Simulated connection loss after COMMIT");
      });
    await expect(upload(p, requestId)).rejects.toThrow("Simulated connection loss");
    simulated.mockRestore();
    expect(objects.remove).not.toHaveBeenCalled();
    const recovered = await upload(p, requestId);
    expect(recovered.files).toHaveLength(1);
    expect(data.size).toBe(1);
  },
);

databaseTest("archive withdraws access and preserves versions for restoration", async () => {
  let p = await share(await create(), "global");
  p = await library.call(actor, {
    action: "archive",
    id: p.id,
    input: { requestId: randomUUID(), expectedVersion: p.version, archived: true },
  });
  expect((await library.call(bob, { action: "list" })).packages).toEqual([]);
  expect(
    (await library.call(actor, { action: "list", input: { scope: "archived" } })).packages,
  ).toHaveLength(1);
  await expect(library.call(bob, { action: "get", id: p.id })).rejects.toMatchObject({
    statusCode: 404,
  });
  p = await library.call(actor, {
    action: "archive",
    id: p.id,
    input: { requestId: randomUUID(), expectedVersion: p.version, archived: false },
  });
  expect((await library.call(bob, { action: "get", id: p.id })).instructions).toBe(
    "Private method",
  );
  expect((await library.call(actor, { action: "history", id: p.id })).versions).toHaveLength(4);
});

databaseTest(
  "bounded file work leaves metadata available and releases capacity after failure",
  async () => {
    const first = await create(),
      second = await create();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = vi.mocked(objects.put).mockImplementation(async () => {
      await pending;
      throw new Error("Fixture storage failure");
    });
    const uploads = [upload(first), upload(second)];
    const results = Promise.allSettled(uploads);
    try {
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      await expect(upload(first)).rejects.toMatchObject({ statusCode: 429, code: "library_busy" });
      expect((await library.call(actor, { action: "get", id: first.id })).version).toBe(1);
    } finally {
      release();
      await results;
      put.mockImplementation(async (key, bytes) => {
        data.set(key, Buffer.from(bytes));
      });
    }
    expect((await upload(first)).files).toHaveLength(1);
  },
);

databaseTest("maintenance removes only expired unpublished uploads", async () => {
  const p = await upload(await create());
  const current = p.files[0],
    expired = randomUUID(),
    recent = randomUUID();
  for (const id of [expired, recent]) {
    const key = `packages/${p.id}/${id}`;
    data.set(key, Buffer.from("pending"));
    await sql`INSERT INTO toolstack_content_files(org_id,owner_membership_id,id,package_id,owner_id,object_key,name,role,media_type,bytes,sha256,state)
      VALUES(${actor.orgId},${actor.membershipId},${id},${p.id},${actor.userId},${key},'pending.txt','reference','text/plain',7,'fixture','pending')`;
  }
  await sql`UPDATE toolstack_content_files SET created_at=now()-interval '25 hours' WHERE id IN (${expired},${current.id})`;
  expect((await library.prunePending()).removed).toBe(1);
  expect(data.has(`packages/${p.id}/${expired}`)).toBe(false);
  expect(data.has(`packages/${p.id}/${recent}`)).toBe(true);
  expect(
    (await library.call(actor, { action: "file", id: p.id, input: { file: current.id } })).sha256,
  ).toBe(current.sha256);
});

databaseTest(
  "MCP registration uses the library service without granting execution of uploaded scripts",
  async () => {
    vi.stubEnv("STEEL_USER_ID", "alice");
    const registry = new ToolRegistry([libraryToolkit(() => library)]);
    const context = {
      requestId: "fixture",
      signal: new AbortController().signal,
      agent: { name: "admin", admin: true, dailyBudgetBytes: 1000 },
    };
    const result = await registry.execute(
      "library_create",
      { requestId: randomUUID(), title: "MCP method", instructions: "Use the approved tool." },
      context,
    );
    const p = JSON.parse((result.content[0] as any).text);
    expect(p.owner).toBe("alice");
    const read = await registry.execute("library_get", { id: p.id }, context);
    expect(JSON.parse((read.content[0] as any).text).instructions).toBe("Use the approved tool.");
    expect(registry.list(context).some((tool) => /shell|script_execute/.test(tool.name))).toBe(
      false,
    );
  },
);

databaseTest(
  "foreign organization and membership contexts cannot read globally shared content",
  async () => {
    const p = await share(await upload(await create()), "global");
    for (const identity of [
      organizationMember("alice", { id: randomUUID(), name: "Other organization" }),
      { ...actor, membershipId: randomUUID() },
    ]) {
      for (const command of [
        { action: "list" as const },
        { action: "get" as const, id: p.id },
        { action: "file" as const, id: p.id, input: { file: p.files[0].id } },
      ])
        await expect(library.call(identity, command)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(objects.get).not.toHaveBeenCalled();
    const foreign = new ContentLibrary(sql, objects, {
      id: randomUUID(),
      name: "Other organization",
    });
    await expect(foreign.ready).rejects.toThrow("another organization");
    expect((await library.call(actor, { action: "get", id: p.id })).id).toBe(p.id);
    await expect(
      sql`INSERT INTO toolstack_memberships(org_id,id,user_id) VALUES(${randomUUID()},${randomUUID()},'foreign')`,
    ).rejects.toMatchObject({ code: "23503" });
  },
);

databaseTest(
  "legacy content, assignments and object keys survive the organization migration",
  async () => {
    const legacySchema = `legacy_${randomUUID().replaceAll("-", "")}`;
    await root!.unsafe(`CREATE SCHEMA ${legacySchema}`);
    const legacy = postgres(url!, {
      max: 2,
      onnotice: () => {},
      connection: { search_path: legacySchema },
    });
    let migrated: ContentLibrary | undefined;
    try {
      await legacy.unsafe(migration);
      const id = randomUUID(),
        file = randomUUID(),
        key = `packages/${id}/${file}`,
        bytes = Buffer.from("legacy file");
      data.set(key, bytes);
      await legacy`INSERT INTO toolstack_packages(id,owner_id,title,description,kind,latest,visibility,assigned_to) VALUES(${id},'alice','Legacy','Preserved','skill',1,'assigned',${legacy.json(["bob"])})`;
      await legacy`INSERT INTO toolstack_package_versions(package_id,version,owner_id,request_id,request_hash,operation,title,description,kind,instructions,file_ids) VALUES(${id},1,'alice',${randomUUID()},'legacy','create','Legacy','Preserved','skill','Original private method',${legacy.json([file])})`;
      await legacy`INSERT INTO toolstack_content_files(id,package_id,owner_id,object_key,name,role,media_type,bytes,sha256,state) VALUES(${file},${id},'alice',${key},'legacy.txt','reference','text/plain',${bytes.length},${createHash("sha256").update(bytes).digest("hex")},'ready')`;
      migrated = new ContentLibrary(legacy, objects);
      await migrated.ready;
      const result = await migrated.call(bob, { action: "get", id });
      expect(result).toMatchObject({
        orgId: currentOrganization().id,
        ownerMembershipId: actor.membershipId,
        instructions: "Original private method",
        version: 1,
      });
      expect(
        Buffer.from(
          (await migrated.call(bob, { action: "file", id, input: { file } })).base64,
          "base64",
        ),
      ).toEqual(bytes);
      const [stored] =
        await legacy`SELECT object_key FROM toolstack_content_files WHERE id=${file}`;
      expect(stored.object_key).toBe(key);
      expect(
        (await legacy`SELECT assigned_memberships FROM toolstack_packages WHERE id=${id}`)[0]
          .assigned_memberships,
      ).toEqual([bob.membershipId]);
    } finally {
      await (migrated ? migrated.close() : legacy.end({ timeout: 2 }));
      await root!.unsafe(`DROP SCHEMA ${legacySchema} CASCADE`);
    }
  },
);

test("Wasabi ciphertext rejects corruption and object substitution", async () => {
  const storage = new WasabiObjects(
    "fixture-bucket",
    "us-east-1",
    "fixture-key",
    "fixture-secret",
    "ab".repeat(32),
  );
  let bytes: Buffer;
  const send = vi
    .spyOn((storage as any).client, "send")
    .mockImplementation(async (command: any) => {
      if (command.constructor.name === "PutObjectCommand") {
        bytes = command.input.Body;
        return {};
      }
      return {
        Body: (async function* () {
          yield bytes;
        })(),
      };
    });
  await storage.put("fixture/object", Buffer.from("private source"));
  expect(bytes!.includes(Buffer.from("private source"))).toBe(false);
  expect((await storage.get("fixture/object")).toString()).toBe("private source");
  await expect(storage.get("fixture/other-object")).rejects.toThrow();
  bytes![bytes!.length - 1] ^= 1;
  await expect(storage.get("fixture/object")).rejects.toThrow();
  send.mockRestore();
  storage.close();
});
