import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFor, browserOriginAllowed, suppliedKey } from "../../utils/api-key.js";
import { assertAgentCurrent } from "../../services/agent-access.js";
import { libraryActor } from "../../services/library/contracts.js";
import { PublicError } from "../../utils/public-error.js";
import { attachmentContentDisposition } from "../../utils/content-disposition.js";
import { credentialDigest, jobWorkerAuthorized } from "../../services/jobs/access.js";
import type { JobService } from "../../services/jobs/service.js";

export async function jobRequest(req: FastifyRequest) {
  const agent = agentFor(req.raw);
  if (!agent) throw new PublicError("unauthorized", "Sign in to Toolstack", 401);
  if (!browserOriginAllowed(req.raw))
    throw new PublicError("forbidden_origin", "Use the Toolstack origin", 403);
  await assertAgentCurrent(agent);
  return {
    actor: libraryActor(agent),
    authorization: { keyHash: credentialDigest(suppliedKey(req.raw).key!) },
  };
}
export function requireJobs(jobs: JobService | undefined) {
  if (!jobs)
    throw new PublicError(
      "jobs_unavailable",
      "Background jobs are not enabled for this workspace",
      503,
    );
  return jobs;
}
export async function callJob<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PublicError || error instanceof z.ZodError) throw error;
    throw new PublicError(
      "jobs_unavailable",
      "Job storage is temporarily unavailable. Retry with the same request ID.",
      503,
    );
  }
}
export async function jobsRoutes(server: FastifyInstance) {
  server.post("/internal/jobs/ready",async(req,reply)=>{
    reply.header("cache-control","no-store");
    if(!jobWorkerAuthorized(req.raw))return reply.code(401).send({ready:false});
    await requireJobs(server.jobs).ready;
    return {ready:true};
  });
  server.post<{ Params: { id: string } }>("/internal/jobs/:id/authorize", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!jobWorkerAuthorized(req.raw)) return reply.code(401).send({ active: false });
    return callJob(async () => ({
      active: await requireJobs(server.jobs).authorizeWork(req.params.id),
    }));
  });
  server.get("/v1/jobs", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { actor } = await jobRequest(req);
    return callJob(() => requireJobs(server.jobs).list(actor, req.query));
  });
  server.post("/v1/jobs", { bodyLimit: 8192 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { actor, authorization } = await jobRequest(req);
    const job = await callJob(() =>
      requireJobs(server.jobs).submit(actor, req.body, authorization),
    );
    return reply.code(202).header("location", `/v1/jobs/${job.id}`).send(job);
  });
  server.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { actor } = await jobRequest(req);
    return callJob(() => requireJobs(server.jobs).get(actor, req.params.id));
  });
  server.post<{ Params: { id: string } }>(
    "/v1/jobs/:id/cancel",
    { bodyLimit: 1024 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const { actor } = await jobRequest(req);
      return callJob(() => requireJobs(server.jobs).cancel(actor, req.params.id));
    },
  );
  server.delete<{ Params: { id: string } }>("/v1/jobs/:id/result", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { actor } = await jobRequest(req);
    return callJob(() => requireJobs(server.jobs).removeResult(actor, req.params.id));
  });
  server.route<{ Params: { id: string } }>({
    method: ["GET", "HEAD"],
    url: "/v1/jobs/:id/result",
    handler: async (req, reply) => {
      const { actor } = await jobRequest(req);
      const file = await callJob(async () =>
        req.method === "HEAD"
          ? await requireJobs(server.jobs).resultInfo(actor, req.params.id)
          : await requireJobs(server.jobs).download(actor, req.params.id),
      );
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-type", "application/zip")
        .header("content-disposition", attachmentContentDisposition(file.name))
        .header("content-length", typeof file.bytes === "number" ? file.bytes : file.bytes.length)
        .header("x-content-sha256", file.sha256);
      return req.method === "HEAD" ? reply.send() : reply.send(file.bytes);
    },
  });
}
