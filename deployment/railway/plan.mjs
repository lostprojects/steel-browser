// Preview one service's Railway operations through rw. This script has no
// apply mode and must not read or print secret values. Profiles contain settings
// and Railway variable references only; deployment approval is separate.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const role = process.argv[2];
if (!["web", "api", "scheduler", "browser", "jobs"].includes(role))
  throw new Error("Pass a service profile name");
const profile = JSON.parse(
  await readFile(new URL(`./${role}.profile.json`, import.meta.url), "utf8"),
);
const serviceId = profile.serviceId ?? "<new-service-id>";
function preview(query, variables) {
  process.stdout.write(
    execFileSync("rw", ["api", query, "--vars", JSON.stringify(variables)], { encoding: "utf8" }),
  );
}
console.log(`Preview only: ${profile.source.repo} / ${profile.serviceName}`);
if (!profile.serviceId)
  preview("mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id}}", {
    input: { projectId: profile.projectId, name: profile.serviceName },
  });
preview(
  "mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}",
  {
    serviceId,
    environmentId: profile.environmentId,
    input: profile.settings,
  },
);
preview("mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}", {
  input: {
    projectId: profile.projectId,
    environmentId: profile.environmentId,
    serviceId,
    variables: profile.variables,
    skipDeploys: true,
  },
});
preview(
  "mutation($id:String!,$input:ServiceConnectInput!){serviceConnect(id:$id,input:$input){id}}",
  {
    id: serviceId,
    input: profile.source,
  },
);
console.log(
  "No Railway changes made. Reconcile the source branch and release prerequisites before applying or deploying.",
);
