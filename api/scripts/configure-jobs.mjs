// Stages one organization executor and its scoped control credential. Does not
// deploy, alter browser settings, borrow public DB endpoints or print secrets.
import { readFile, writeFile, rename } from "node:fs/promises";
import { parseEnv, parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
console.log(
  JSON.stringify({
    apply: values.apply,
    actions: [
      "pre-release backups",
      "dedicated pg-boss schema",
      "one private executor service",
      "stage job configuration",
    ],
    deploy: false,
  }),
);
if (!values.apply) process.exit(0);
async function main() {
  const file = "/Users/moi/nosync.nosync/-env/toolstack.env";
  const state = parseEnv(await readFile(file, "utf8")),
    global = parseEnv(await readFile("/Users/moi/nosync.nosync/-env/global.env", "utf8"));
  const projectId = "bbbe0a8e-81f7-41b9-9d64-76a38ad7d8fb",
    environmentId = "1ff52f6b-2c4d-4a5d-835d-fe90506420d2",
    ownerId = "cb27d380-5f19-4057-b8b5-402bf34f2678";
  async function gql(query, variables = {}) {
    const response = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        authorization: `Bearer ${global.RAILWAY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || result.errors)
      throw Error("Railway jobs configuration failed; private diagnostics suppressed");
    return result.data;
  }
  async function persist() {
    const tmp = file + ".tmp";
    await writeFile(
      tmp,
      Object.entries(state)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(tmp, file);
  }
  const { variables: owner } = await gql(
    "query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
    { p: projectId, e: environmentId, s: ownerId },
  );
  const storage = [
    "TOOLSTACK_ORG_ID",
    "TOOLSTACK_ORG_NAME",
    "TOOLSTACK_DATABASE_URL",
    "TOOLSTACK_WASABI_BUCKET",
    "TOOLSTACK_WASABI_REGION",
    "TOOLSTACK_WASABI_ACCESS_KEY",
    "TOOLSTACK_WASABI_SECRET_KEY",
    "TOOLSTACK_CONTENT_KEY",
  ];
  if (
    owner.MAX_SESSIONS !== "12" ||
    (owner.STEEL_ROLE && owner.STEEL_ROLE !== "standalone") ||
    storage.some((name) => !state[name] || owner[name] !== state[name])
  )
    throw Error("Existing owner organization or storage binding changed");
  if (new URL(state.TOOLSTACK_DATABASE_URL).username !== "toolstack_app")
    throw Error("Use the restricted Toolstack database account");
  state.TOOLSTACK_JOBS_WORKER_KEY ??= randomBytes(32).toString("hex");
  if (
    owner.TOOLSTACK_JOBS_WORKER_KEY &&
    owner.TOOLSTACK_JOBS_WORKER_KEY !== state.TOOLSTACK_JOBS_WORKER_KEY
  )
    throw Error("Refusing implicit executor credential rotation");
  await persist();
  for (const volume of [
    "e6886add-c9a0-429c-b935-7df7ab072dca",
    "d573660c-9b68-4d70-9a3f-4a60899105ff",
  ])
    await gql(
      'mutation($id:String!){volumeInstanceBackupCreate(volumeInstanceId:$id,name:"Before durable jobs"){workflowId}}',
      { id: volume },
    );
  let proxy, sql;
  try {
    const existing = await gql(
      "query($e:String!,$s:String!){tcpProxies(environmentId:$e,serviceId:$s){id}}",
      { e: environmentId, s: state.TOOLSTACK_POSTGRES_SERVICE_ID },
    );
    if (existing.tcpProxies.length)
      throw Error("A database proxy already exists; refusing to borrow it");
    proxy = (
      await gql(
        "mutation($input:TCPProxyCreateInput!){tcpProxyCreate(input:$input){id domain proxyPort}}",
        {
          input: {
            environmentId,
            serviceId: state.TOOLSTACK_POSTGRES_SERVICE_ID,
            applicationPort: 5432,
          },
        },
      )
    ).tcpProxyCreate;
    const url = new URL(state.TOOLSTACK_DATABASE_URL);
    url.hostname = proxy.domain;
    url.port = String(proxy.proxyPort);
    url.username = "toolstack";
    url.password = state.TOOLSTACK_DATABASE_PASSWORD;
    sql = postgres(url.href, { max: 1, ssl: "require", connect_timeout: 10, onnotice: () => {} });
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        await sql`SELECT 1`;
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!ready) throw Error("Temporary database endpoint did not become ready");
    const [organization] = await sql`SELECT id FROM toolstack_organizations`;
    if (organization?.id !== state.TOOLSTACK_ORG_ID) throw Error("Database organization mismatch");
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS toolstack_queue AUTHORIZATION toolstack_app");
    const [schema] =
      await sql`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='toolstack_queue'`;
    if (schema?.owner !== "toolstack_app") throw Error("Queue schema ownership mismatch");
  } finally {
    await sql?.end({ timeout: 3 });
    if (proxy) await gql("mutation($id:String!){tcpProxyDelete(id:$id)}", { id: proxy.id });
  }
  const project = await gql("query($id:String!){project(id:$id){services{edges{node{id name}}}}}", {
    id: projectId,
  });
  if (!state.TOOLSTACK_JOBS_SERVICE_ID) {
    if (project.project.services.edges.some((e) => e.node.name === "Toolstack jobs"))
      throw Error("An unbound jobs service already exists");
    state.TOOLSTACK_JOBS_SERVICE_ID = (
      await gql("mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id}}", {
        input: { projectId, environmentId, name: "Toolstack jobs" },
      })
    ).serviceCreate.id;
    await persist();
  } else if (
    !project.project.services.edges.some(
      (e) => e.node.id === state.TOOLSTACK_JOBS_SERVICE_ID && e.node.name === "Toolstack jobs",
    )
  )
    throw Error("Executor service binding mismatch");
  const workerId = state.TOOLSTACK_JOBS_SERVICE_ID;
  const controlOrigin = owner.RAILWAY_PRIVATE_DOMAIN
    ? `http://${owner.RAILWAY_PRIVATE_DOMAIN}:${owner.PORT || 8080}`
    : "https://steel-browser-production-e8d5.up.railway.app";
  const variables = {
    ...Object.fromEntries(storage.map((name) => [name, state[name]])),
    STEEL_ROLE: "executor",
    STEEL_IMAGE: "jobs",
    NODE_ENV: "production",
    HOST: "::",
    PORT: "8080",
    TOOLSTACK_JOBS_ORIGIN: controlOrigin,
    TOOLSTACK_JOBS_WORKER_KEY: state.TOOLSTACK_JOBS_WORKER_KEY,
  };
  await gql(
    "mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
    {
      input: {
        projectId,
        environmentId,
        serviceId: workerId,
        variables,
        replace: false,
        skipDeploys: true,
      },
    },
  );
  await gql(
    "mutation($s:String!,$e:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$input)}",
    {
      s: workerId,
      e: environmentId,
      input: {
        healthcheckPath: "/health",
        healthcheckTimeout: 120,
        numReplicas: 1,
        sleepApplication: false,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 3,
      },
    },
  );
  await gql(
    "mutation($input:ServiceInstanceLimitsUpdateInput!){serviceInstanceLimitsUpdate(input:$input)}",
    { input: { serviceId: workerId, environmentId, memoryGB: 0.5, vCPUs: 1 } },
  );
  await gql(
    "mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
    {
      input: {
        projectId,
        environmentId,
        serviceId: ownerId,
        variables: {
          TOOLSTACK_JOBS_ENABLED: "true",
          TOOLSTACK_JOBS_WORKER_KEY: state.TOOLSTACK_JOBS_WORKER_KEY,
        },
        replace: false,
        skipDeploys: true,
      },
    },
  );
  const checked = await gql(
    "query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
    { p: projectId, e: environmentId, s: workerId },
  );
  if (
    Object.entries(variables).some(([k, v]) => checked.variables[k] !== v) ||
    [
      "VAULT_KEY",
      "STEEL_API_KEY",
      "STEEL_AGENT_KEYS",
      "EVOMI_RESIDENTIAL_PROXY_URL",
      "GATEWAY_STORE_KEY",
    ].some((k) => checked.variables[k])
  )
    throw Error("Executor configuration failed its credential boundary check");
  console.log(
    JSON.stringify({
      prepared: true,
      queueSchema: "toolstack_queue",
      executorService: workerId,
      replicas: 1,
      memoryMiB: 512,
      vCPUs: 1,
      personalCredentials: false,
      publicDatabaseProxyRemoved: true,
      deploy: false,
    }),
  );
}
await main().catch((error) => {
  console.error("Jobs configuration failed: " + error.name);
  process.exitCode = 1;
});
