import { ContentLibrary } from "../library/library.js";
import { configuredObjects } from "../library/service.js";
import type { LibraryService } from "../library/contracts.js";
import { activeJobCredential } from "./access.js";
import { JobService } from "./service.js";

export function configuredJobs(library: LibraryService | undefined) {
  if (process.env.TOOLSTACK_JOBS_ENABLED !== "true") return;
  if (process.env.STEEL_ROLE && process.env.STEEL_ROLE !== "standalone")
    throw new Error("The current jobs API belongs to the standalone organization service");
  if (
    !(library instanceof ContentLibrary) ||
    (process.env.TOOLSTACK_JOBS_WORKER_KEY?.length ?? 0) < 32
  )
    throw new Error("Jobs require the central library and a dedicated worker-control key");
  return new JobService(library.sql, library, configuredObjects(), async (row) =>
    activeJobCredential(row),
  );
}
