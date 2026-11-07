import { apiUrl, request } from "./api";
export type Job = {
  id: string;
  type: string;
  title: string;
  state: "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";
  progress: number;
  stage: string;
  attempts: number;
  error: string | null;
  packageId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  resultAvailable: boolean;
};
export type JobPage = {
  jobs: Job[];
  total: number;
  nextOffset: number | null;
  workerAvailable: boolean;
};
export const listJobs = (offset = 0, signal?: AbortSignal) =>
  request<JobPage>(`/v1/jobs?limit=20&offset=${offset}`, { signal });
export const readJob = (id: string, signal?: AbortSignal) =>
  request<Job>(`/v1/jobs/${encodeURIComponent(id)}`, { signal });
export const cancelJob = (id: string) =>
  request<Job>(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const exportPackage = (packageId: string, version: number, requestId: string) =>
  request<Job>("/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "library_export", packageId, version, requestId }),
  });
export const jobResult = (id: string) => apiUrl(`/v1/jobs/${encodeURIComponent(id)}/result`);
export const removeJobResult = (id: string) =>
  request<Job>(`/v1/jobs/${encodeURIComponent(id)}/result`, { method: "DELETE" });
