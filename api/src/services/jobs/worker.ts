// Dedicated organization executor. No personal vault, browser key or proxy
// credential may be supplied. Future runtimes require explicit registration.
import http from "node:http";
import { configuredLibrary, configuredObjects } from "../library/service.js";
import { ContentLibrary } from "../library/library.js";
import { currentOrganization } from "../organization.js";
import { JobService } from "./service.js";

export async function startJobWorker() {
  for (const key of [
    "VAULT_KEY",
    "STEEL_API_KEY",
    "STEEL_AGENT_KEYS",
    "GATEWAY_STORE_KEY",
    "EVOMI_RESIDENTIAL_PROXY_URL",
  ])
    if (process.env[key])
      throw new Error(
        "The executor must not receive personal browser, account or gateway credentials",
      );
  const organization = currentOrganization(),
    key = process.env.TOOLSTACK_JOBS_WORKER_KEY;
  const origin = new URL(process.env.TOOLSTACK_JOBS_ORIGIN ?? "");
  if (
    !key ||
    key.length < 32 ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && origin.hostname.endsWith(".railway.internal"))
    )
  )
    throw new Error("Configure the executor's organization service origin and control credential");
  const library = configuredLibrary();
  if (!(library instanceof ContentLibrary))
    throw new Error("Configure the executor's organization data storage");
  await library.ready;
  const control=await fetch(new URL("/internal/jobs/ready",origin),{method:"POST",redirect:"error",
    headers:{authorization:`Bearer ${key}`,"x-toolstack-org-id":organization.id},signal:AbortSignal.timeout(15000)});
  if(!control.ok){await control.body?.cancel();throw new Error("Organization job control is not ready");}
  if((await control.json()).ready!==true)throw new Error("Organization job control is not ready");
  const jobs = new JobService(
    library.sql,
    library,
    configuredObjects(),
    async (row) => {
      const response = await fetch(new URL(`/internal/jobs/${row.id}/authorize`, origin), {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${key}`, "x-toolstack-org-id": organization.id },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Job authorization temporarily unavailable");
      }
      return (await response.json()).active === true;
    },
    { supervise: true },
  );
  await jobs.work();
  let stopping = false;
  const health = http.createServer((req, res) => {
    res.writeHead(!stopping && req.url === "/health" ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ status: stopping ? "draining" : "ok" }));
  });
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "::", resolve);
  });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    try {
      await jobs.close();
      await library.close();
      health.close();
      console.log("Job executor stopped");
      process.exit(0);
    } catch {
      console.error("Job executor shutdown failed");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  console.log("Organization job executor ready; concurrency 1");
}

if (process.env.STEEL_ROLE === "executor") await startJobWorker();
