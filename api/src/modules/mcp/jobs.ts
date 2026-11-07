import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Toolkit } from "../../services/toolkits/registry.js";
import { jobsQuery, submitJob } from "../../services/jobs/contracts.js";
import { jobRequest, requireJobs, callJob } from "../application/jobs.routes.js";
import { getUrl } from "../../utils/url.js";
import { textResult } from "./tools.js";

export function jobsToolkit(server: FastifyInstance): Toolkit {
  const id = z.object({ id: z.string().uuid() }).strict();
  return {
    id: "jobs",
    name: "Background jobs",
    version: "1.0.0",
    description: "Durable private jobs with progress, cancellation and saved results",
    authentication: "Uses your organization membership and current Toolstack connection.",
    tools: [
      {
        name: "jobs_submit",
        description:
          "Queue an owner-only export of an exact saved Library package version. Reuse requestId after a transport interruption. This operation does not run uploaded scripts.",
        input: submitJob,
      },
      {
        name: "jobs_list",
        description: "List your private durable jobs and executor availability.",
        input: jobsQuery,
      },
      {
        name: "jobs_get",
        description: "Read your job's progress, failure or completed result status.",
        input: id,
      },
      {
        name: "jobs_cancel",
        description: "Cancel your queued or running job; completed results are unchanged.",
        input: id,
      },
      {
        name: "jobs_remove_result",
        description:
          "Remove your completed job result. Its download becomes unavailable; the saved Library source is preserved.",
        input: id,
      },
      {
        name: "jobs_result",
        description:
          "Get an authenticated download address for your completed export. Results expire after seven days.",
        input: id,
      },
    ].map((definition) => ({
      ...definition,
      annotations: {
        readOnlyHint: !["jobs_submit", "jobs_cancel", "jobs_remove_result"].includes(
          definition.name,
        ),
        openWorldHint: false,
      },
      execute: async (args, context) => {
        const { actor, authorization } = await jobRequest(
          (context as typeof context & { request: FastifyRequest }).request,
        );
        return callJob(async () => {
          const jobs = requireJobs(server.jobs);
          if (definition.name === "jobs_submit")
            return textResult(await jobs.submit(actor, args, authorization));
          if (definition.name === "jobs_list") return textResult(await jobs.list(actor, args));
          if (definition.name === "jobs_cancel")
            return textResult(await jobs.cancel(actor, args.id as string));
          if (definition.name === "jobs_remove_result")
            return textResult(await jobs.removeResult(actor, args.id as string));
          const job = await jobs.get(actor, args.id as string);
          if (definition.name !== "jobs_result" || !job.resultAvailable) return textResult(job);
          // Metadata rechecks source access without fetching the whole object.
          // The download endpoint verifies bytes against this saved checksum.
          const file = await jobs.resultInfo(actor, job.id);
          return {
            content: [
              ...textResult({
                job: job.id,
                name: file.name,
                bytes: file.bytes,
                sha256: file.sha256,
              }).content,
              {
                type: "resource_link",
                name: file.name,
                uri: getUrl(`v1/jobs/${job.id}/result`),
                mimeType: "application/zip",
              },
            ],
          };
        });
      },
    })),
  };
}
