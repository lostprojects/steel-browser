// Initializes and verifies only the newly provisioned Toolstack database.
// Creates a temporary TLS TCP proxy, a restricted application role and private
// fixture records. It removes the proxy and fixture bytes on completion.
// Never point this at PMS, copy root credentials into workers, or print secrets.
import { readFile, writeFile, rename } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import postgres from "postgres";
import { organizationMember } from "../build/services/organization.js";
import { ContentLibrary } from "../build/services/library/library.js";
import { WasabiObjects } from "../build/services/library/objects.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    hosted: { type: "boolean", default: false },
    env: { type: "string", default: "/Users/moi/nosync.nosync/-env/toolstack.env" },
    "global-env": { type: "string", default: "/Users/moi/nosync.nosync/-env/global.env" },
  },
});
console.log(
  JSON.stringify({
    apply: values.apply,
    service: "Toolstack Postgres",
    actions: [
      "temporary encrypted database access",
      "restricted application role",
      "schema migration",
      "Wasabi/Postgres recovery verification",
    ],
    existingBrowserWorker: "unchanged",
    hostedLibraryAcceptance: values.hosted,
  }),
);
if (!values.apply) process.exit(0);
const state = parseEnv(await readFile(values.env, "utf8"));
const global = parseEnv(await readFile(values["global-env"], "utf8"));
for (const name of ["TOOLSTACK_ORG_ID", "TOOLSTACK_ORG_NAME"])
  if (state[name]) process.env[name] = state[name];
const environmentId = "1ff52f6b-2c4d-4a5d-835d-fe90506420d2",
  projectId = "bbbe0a8e-81f7-41b9-9d64-76a38ad7d8fb";
const persist = async () => {
  const tmp = values.env + ".tmp";
  await writeFile(
    tmp,
    Object.entries(state)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await rename(tmp, values.env);
};
async function gql(query, variables = {}) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      authorization: `Bearer ${global.RAILWAY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors)
    throw new Error("Railway storage verification request failed; diagnostic body suppressed");
  return result.data;
}
const objects = () =>
  new WasabiObjects(
    state.TOOLSTACK_WASABI_BUCKET,
    state.TOOLSTACK_WASABI_REGION,
    state.TOOLSTACK_WASABI_ACCESS_KEY,
    state.TOOLSTACK_WASABI_SECRET_KEY,
    state.TOOLSTACK_CONTENT_KEY,
  );
let proxy, admin, library, appSql;
let report;
let stage = "service binding";
const fixtureOwner = `verification_${randomBytes(8).toString("hex")}`,
  owned = [];
const fixtureMembers = new Set([fixtureOwner, fixtureOwner + "_reader"]);
try {
  const project = await gql("query($p:String!){project(id:$p){services{edges{node{id name}}}}}", {
    p: projectId,
  });
  if (
    !project.project.services.edges.some(
      (edge) =>
        edge.node.id === state.TOOLSTACK_POSTGRES_SERVICE_ID &&
        edge.node.name === "Toolstack Postgres",
    )
  )
    throw new Error("Database service binding mismatch");
  const existing = await gql(
    "query($e:String!,$s:String!){tcpProxies(environmentId:$e,serviceId:$s){id domain proxyPort applicationPort}}",
    { e: environmentId, s: state.TOOLSTACK_POSTGRES_SERVICE_ID },
  );
  if (existing.tcpProxies.length)
    throw new Error(
      "Database already has a TCP proxy; refusing to alter or borrow an existing public endpoint",
    );
  const created = await gql(
    "mutation($input:TCPProxyCreateInput!){tcpProxyCreate(input:$input){id domain proxyPort}}",
    {
      input: {
        environmentId,
        serviceId: state.TOOLSTACK_POSTGRES_SERVICE_ID,
        applicationPort: 5432,
      },
    },
  );
  proxy = created.tcpProxyCreate;
  stage = "database connection";
  const privateUrl = new URL(state.TOOLSTACK_DATABASE_URL);
  const publicUrl = new URL(privateUrl);
  publicUrl.hostname = proxy.domain;
  publicUrl.port = String(proxy.proxyPort);
  publicUrl.username = "toolstack";
  publicUrl.password = state.TOOLSTACK_DATABASE_PASSWORD;
  admin = postgres(publicUrl.href, {
    max: 1,
    ssl: "require",
    connect_timeout: 10,
    onnotice: () => {},
  });
  let connected = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await admin`SELECT 1`;
      connected = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!connected) throw new Error("New database proxy did not become ready");
  stage = "application role";
  state.TOOLSTACK_DATABASE_APP_PASSWORD ||= randomBytes(32).toString("hex");
  await persist();
  await admin.unsafe(`CREATE OR REPLACE FUNCTION pg_temp.toolstack_app_role(secret text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='toolstack_app') THEN
      EXECUTE format('CREATE ROLE toolstack_app LOGIN PASSWORD %L',secret);
    END IF; END $$`);
  await admin`SELECT pg_temp.toolstack_app_role(${state.TOOLSTACK_DATABASE_APP_PASSWORD})`;
  await admin`GRANT CONNECT ON DATABASE toolstack TO toolstack_app`;
  await admin`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
  await admin`GRANT USAGE,CREATE ON SCHEMA public TO toolstack_app`;
  publicUrl.username = "toolstack_app";
  publicUrl.password = state.TOOLSTACK_DATABASE_APP_PASSWORD;
  appSql = postgres(publicUrl.href, {
    max: 3,
    ssl: "require",
    connect_timeout: 10,
    onnotice: () => {},
  });
  const [role] =
    await appSql`SELECT rolname,rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user`;
  assert.deepEqual([role.rolsuper, role.rolcreaterole, role.rolcreatedb], [false, false, false]);
  library = new ContentLibrary(appSql, objects());
  await library.ready;
  stage = "previous fixture cleanup";
  // Recover only this verifier's identifiable fixtures after an interrupted
  // cleanup. All version bodies must match the verifier's fixed content.
  const cleanupFixtures = async () => {
    const rows = await appSql`SELECT p.id,p.owner_id FROM toolstack_packages p
      WHERE p.owner_id ~ '^verification_[0-9a-f]{16}$' AND p.title='Storage verification'
      AND EXISTS(SELECT 1 FROM toolstack_package_versions v WHERE v.package_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM toolstack_package_versions v WHERE v.package_id=p.id
        AND (v.owner_id<>p.owner_id OR v.title<>'Storage verification' OR v.instructions<>'Private fixture')) LIMIT 10`;
    const bytes = objects();
    try {
      for (const row of rows) {
        fixtureMembers.add(row.owner_id);
        fixtureMembers.add(row.owner_id + "_reader");
        const files =
          await appSql`SELECT object_key FROM toolstack_content_files WHERE package_id=${row.id} AND owner_id=${row.owner_id}`;
        for (const file of files) await bytes.remove(file.object_key);
        await appSql.begin(async (tx) => {
          await tx`DELETE FROM toolstack_package_versions WHERE package_id=${row.id} AND owner_id=${row.owner_id}`;
          await tx`DELETE FROM toolstack_content_files WHERE package_id=${row.id} AND owner_id=${row.owner_id}`;
          await tx`DELETE FROM toolstack_packages WHERE id=${row.id} AND owner_id=${row.owner_id}`;
        });
      }
      return rows.length;
    } finally {
      bytes.close();
    }
  };
  const recovered = await cleanupFixtures();
  stage = "private package and encrypted upload";
  let p = await library.call(organizationMember(fixtureOwner), {
    action: "create",
    input: {
      requestId: randomUUID(),
      title: "Storage verification",
      instructions: "Private fixture",
    },
  });
  owned.push({ id: p.id, owner: fixtureOwner });
  p = await library.call(organizationMember(fixtureOwner), {
    action: "upload",
    id: p.id,
    input: {
      requestId: randomUUID(),
      expectedVersion: p.version,
      name: "fixture.py",
      role: "script",
      mediaType: "text/x-python",
      base64: Buffer.from("print('verification')\n").toString("base64"),
    },
  });
  const file = p.files[0],
    reader = organizationMember(fixtureOwner + "_reader");
  stage = "assignment and download";
  await assert.rejects(library.call(reader, { action: "get", id: p.id }));
  p = await library.call(organizationMember(fixtureOwner), {
    action: "share",
    id: p.id,
    input: {
      requestId: randomUUID(),
      expectedVersion: p.version,
      visibility: "assigned",
      assignedTo: [reader.userId],
    },
  });
  assert.equal(
    Buffer.from(
      (await library.call(reader, { action: "file", id: p.id, input: { file: file.id } })).base64,
      "base64",
    ).toString(),
    "print('verification')\n",
  );
  await library.close();
  stage = "restart recovery";
  library = undefined;
  appSql = postgres(publicUrl.href, {
    max: 3,
    ssl: "require",
    connect_timeout: 10,
    onnotice: () => {},
  });
  library = new ContentLibrary(appSql, objects());
  await library.ready;
  assert.equal(
    (await library.call(organizationMember(fixtureOwner), { action: "get", id: p.id })).version,
    p.version,
  );
  p = await library.call(organizationMember(fixtureOwner), {
    action: "share",
    id: p.id,
    input: { requestId: randomUUID(), expectedVersion: p.version, visibility: "private" },
  });
  await assert.rejects(
    library.call(reader, { action: "file", id: p.id, input: { file: file.id } }),
  );
  privateUrl.username = "toolstack_app";
  privateUrl.password = state.TOOLSTACK_DATABASE_APP_PASSWORD;
  privateUrl.searchParams.set("sslmode", "require");
  state.TOOLSTACK_DATABASE_URL = privateUrl.href;
  state.TOOLSTACK_DATABASE_ROLE = "toolstack_app";
  await persist();
  if (values.hosted) {
    stage = "hosted Library acceptance";
    const serviceId = "cb27d380-5f19-4057-b8b5-402bf34f2678";
    const { variables } = await gql(
      "query($e:String!,$s:String!,$p:String!){variables(environmentId:$e,serviceId:$s,projectId:$p)}",
      { e: environmentId, s: serviceId, p: projectId },
    );
    const origin = "https://steel-browser-production-e8d5.up.railway.app";
    const request = async (path, method = "GET", input) => {
      const response = await fetch(origin + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
        headers: {
          authorization: `Bearer ${variables.STEEL_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (!response.ok) throw new Error(`Hosted acceptance HTTP ${response.status}`);
      return response;
    };
    const health = await (await request("/v1/health")).json();
    assert.equal(health.status, "ok");
    assert.equal(health.maxSessions, 12);
    assert.ok(health.capabilities.includes("content_library"));
    const context = await (await request("/v1/organization")).json();
    assert.equal(context.organization.id, state.TOOLSTACK_ORG_ID);
    assert.equal(context.membership.id, organizationMember(context.membership.userId).membershipId);
    const listed = await (await request("/v1/library")).json();
    assert.equal(listed.organization.id, context.organization.id);
    assert.equal(listed.membershipId, context.membership.id);
    assert.equal(
      (
        await fetch(origin + "/v1/library", {
          headers: {
            authorization: `Bearer ${variables.STEEL_API_KEY}`,
            "x-toolstack-org-id": randomUUID(),
          },
          signal: AbortSignal.timeout(15000),
        })
      ).status,
      401,
    );
    const before = await (await request("/v1/connections")).json();
    let hosted = await (
      await request("/v1/library", "POST", {
        requestId: randomUUID(),
        title: "Hosted storage verification",
        description: "Temporary Toolstack acceptance fixture",
        instructions: "Private fixture",
      })
    ).json();
    assert.equal(hosted.visibility, "private");
    owned.push({ id: hosted.id, owner: hosted.owner });
    const initialized = await (
      await request("/mcp", "POST", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "toolstack-acceptance", version: "1.0.0" },
        },
      })
    ).json();
    assert.ok(initialized.result.instructions.includes("library_list"));
    const tools = await (
      await request("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    ).json();
    assert.ok(tools.result.tools.some((tool) => tool.name === "library_get"));
    const found = await (
      await request("/mcp", "POST", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "library_get", arguments: { id: hosted.id } },
      })
    ).json();
    assert.equal(JSON.parse(found.result.content[0].text).owner, hosted.owner);
    const edit = {
      requestId: randomUUID(),
      expectedVersion: hosted.version,
      title: hosted.title,
      description: hosted.description,
      instructions: "Private fixture updated",
      kind: "skill",
      runtime: null,
      files: [],
    };
    hosted = await (await request(`/v1/library/${hosted.id}`, "PUT", edit)).json();
    const replay = await (await request(`/v1/library/${hosted.id}`, "PUT", edit)).json();
    assert.equal(replay.version, hosted.version);
    const bytes = Buffer.from("Toolstack hosted storage acceptance\n");
    hosted = await (
      await request(`/v1/library/${hosted.id}/files`, "POST", {
        requestId: randomUUID(),
        expectedVersion: hosted.version,
        name: "acceptance.txt",
        role: "reference",
        mediaType: "text/plain",
        base64: bytes.toString("base64"),
      })
    ).json();
    const link = `/v1/library/${hosted.id}/files/${hosted.files[0].id}`;
    const head = await request(link, "HEAD");
    assert.equal(Number(head.headers.get("content-length")), bytes.length);
    const download = await request(link);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(download.headers.get("x-content-sha256"), hosted.files[0].sha256);
    assert.equal((await fetch(origin + link, { signal: AbortSignal.timeout(15000) })).status, 401);
    assert.equal(
      (
        await fetch(origin + "/v1/library", {
          headers: {
            authorization: `Bearer ${variables.STEEL_API_KEY}`,
            origin: "https://example.invalid",
          },
          signal: AbortSignal.timeout(15000),
        })
      ).status,
      403,
    );
    const history = await (await request(`/v1/library/${hosted.id}/history`)).json();
    assert.equal(history.versions.length, 3);
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      await browser.defaultBrowserContext().setCookie({
        name: "steel_api_key",
        value: variables.STEEL_API_KEY,
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.name));
      await page.goto(origin + "/ui/#library", { waitUntil: "networkidle0" });
      await page.waitForFunction(
        () => document.body.innerText.includes("Hosted storage verification"),
        { timeout: 30000 },
      );
      for (const width of [1440, 390]) {
        await page.setViewport({ width, height: 1000 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
      assert.equal(errors.length, 0);
    } finally {
      await browser.close();
    }
    const after = await (await request("/v1/connections")).json();
    assert.deepEqual(after, before);
    report = {
      hostedChecks: [
        "HTTPS-UI",
        "organization-membership-binding",
        "foreign-organization-denied",
        "MCP-initialization-discovery-read",
        "private-create",
        "immutable-save",
        "retry-replay",
        "Wasabi-file-roundtrip",
        "HEAD-metadata",
        "anonymous-denied",
        "foreign-origin-denied",
        "history",
        "desktop-mobile",
        "connections-preserved",
      ],
    };
  }
  stage = "verification completed";
  const [version] = await appSql`SELECT version()`;
  report = {
    ...report,
    passed: true,
    database: version.version,
    applicationRole: role.rolname,
    superuser: false,
    checks: [
      "TLS-database-connection",
      "restricted-role",
      "schema-migration",
      "encrypted-Wasabi-file",
      "private-default",
      "assignment",
      "restart-recovery",
      "revocation",
    ],
    privateRuntimeConfiguration: values.env,
    fixturePackages: owned.length,
    recoveredFixtures: recovered,
    fixturesRemovedOnExit: true,
    publicProxyRemovedOnExit: true,
  };
} catch (error) {
  console.error(`Cloud verification failed during ${stage}: ${error.name}`);
  process.exitCode = 1;
} finally {
  try {
    if (appSql && owned.length) {
      const bytes = objects();
      try {
        for (const { id, owner } of owned) {
          const rows =
            await appSql`SELECT object_key FROM toolstack_content_files WHERE package_id=${id} AND owner_id=${owner}`;
          for (const row of rows) await bytes.remove(row.object_key);
          await appSql.begin(async (tx) => {
            await tx`DELETE FROM toolstack_package_versions WHERE package_id=${id} AND owner_id=${owner}`;
            await tx`DELETE FROM toolstack_content_files WHERE package_id=${id} AND owner_id=${owner}`;
            await tx`DELETE FROM toolstack_packages WHERE id=${id} AND owner_id=${owner}`;
          });
        }
      } finally {
        bytes.close();
      }
    }
    if (appSql) {
      for (const user of fixtureMembers) {
        await appSql`DELETE FROM toolstack_memberships m WHERE m.org_id=${state.TOOLSTACK_ORG_ID}
          AND m.user_id=${user} AND NOT EXISTS(SELECT 1 FROM toolstack_packages p
            WHERE p.org_id=m.org_id AND p.owner_membership_id=m.id)`;
      }
    }
  } catch (error) {
    console.error(
      `Verification fixture cleanup failed: ${error.name}; rerun to recover its fixtures`,
    );
    process.exitCode = 1;
  } finally {
    const closed = await Promise.allSettled([
      library?.close(),
      appSql?.end({ timeout: 3 }),
      admin?.end({ timeout: 3 }),
    ]);
    if (closed.some((result) => result.status === "rejected")) process.exitCode = 1;
    if (proxy) await gql("mutation($id:String!){tcpProxyDelete(id:$id)}", { id: proxy.id });
  }
}
if (report && !process.exitCode) console.log(JSON.stringify(report, null, 2));
