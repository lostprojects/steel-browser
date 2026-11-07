// Stages only central content-library variables on the existing standalone
// owner service. It does not deploy, copy root database credentials, or change
// browser/profile/vault settings. Dry-run is the default.
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs, parseEnv } from "node:util";
const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    env: { type: "string", default: "/Users/moi/nosync.nosync/-env/toolstack.env" },
    "global-env": { type: "string", default: "/Users/moi/nosync.nosync/-env/global.env" },
  },
});
const projectId = "bbbe0a8e-81f7-41b9-9d64-76a38ad7d8fb",
  environmentId = "1ff52f6b-2c4d-4a5d-835d-fe90506420d2",
  serviceId = "cb27d380-5f19-4057-b8b5-402bf34f2678";
const names = [
  "TOOLSTACK_ORG_ID",
  "TOOLSTACK_ORG_NAME",
  "TOOLSTACK_DATABASE_URL",
  "TOOLSTACK_WASABI_BUCKET",
  "TOOLSTACK_WASABI_REGION",
  "TOOLSTACK_WASABI_ACCESS_KEY",
  "TOOLSTACK_WASABI_SECRET_KEY",
  "TOOLSTACK_CONTENT_KEY",
];
console.log(
  JSON.stringify(
    {
      apply: values.apply,
      project: "vigilant-peace",
      service: "Steel Browser",
      variableNames: names,
      deploy: false,
      existingWorkerSettings: "preserved",
    },
    null,
    2,
  ),
);
if (!values.apply) process.exit(0);
const state = parseEnv(await readFile(values.env, "utf8")),
  global = parseEnv(await readFile(values["global-env"], "utf8"));
if (!state.TOOLSTACK_ORG_ID) {
  state.TOOLSTACK_ORG_ID = randomUUID();
  state.TOOLSTACK_ORG_NAME = "My organization";
  const tmp = values.env + ".tmp";
  await writeFile(
    tmp,
    Object.entries(state)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await rename(tmp, values.env);
}
if (
  state.TOOLSTACK_DATABASE_ROLE !== "toolstack_app" ||
  new URL(state.TOOLSTACK_DATABASE_URL).username !== "toolstack_app" ||
  names.some((name) => !state[name]) ||
  state.TOOLSTACK_WASABI_ACCESS_KEY === global.WASABI_ACCESS_KEY
)
  throw new Error("Verify dedicated application storage before configuring the runtime");
async function gql(query, variables) {
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
    throw new Error("Railway configuration request failed; private diagnostics suppressed");
  return result.data;
}
const result = await gql(
  "query($e:String!,$s:String!,$p:String!){service(id:$s){name projectId} variables(environmentId:$e,serviceId:$s,projectId:$p)}",
  { e: environmentId, s: serviceId, p: projectId },
);
if (
  result.service.name !== "Steel Browser" ||
  result.service.projectId !== projectId ||
  ![undefined, "standalone"].includes(result.variables.STEEL_ROLE) ||
  result.variables.MAX_SESSIONS !== "12"
)
  throw new Error(
    "Existing owner service binding or capacity changed; configuration left untouched",
  );
for (const name of names)
  if (result.variables[name] && result.variables[name] !== state[name])
    throw new Error(`Existing ${name} differs; refusing an implicit credential rotation`);
await gql(
  "mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
  {
    input: {
      projectId,
      environmentId,
      serviceId,
      skipDeploys: true,
      replace: false,
      variables: Object.fromEntries(names.map((name) => [name, state[name]])),
    },
  },
);
const verified = await gql(
  "query($e:String!,$s:String!,$p:String!){variables(environmentId:$e,serviceId:$s,projectId:$p)}",
  { e: environmentId, s: serviceId, p: projectId },
);
if (names.some((name) => verified.variables[name] !== state[name]))
  throw new Error("Runtime configuration did not match");
console.log(
  JSON.stringify({ staged: names.length, verified: true, deploy: false, secretsPrinted: false }),
);
