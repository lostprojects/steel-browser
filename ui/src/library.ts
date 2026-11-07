import { request, apiUrl } from "./api";

export type LibraryFile = {
  id: string;
  name: string;
  role: string;
  mediaType: string;
  bytes: number;
  sha256: string;
};
export type PackageSummary = {
  id: string;
  owner: string;
  title: string;
  description: string;
  kind: string;
  version: number;
  latestVersion?: number;
  visibility: "private" | "assigned" | "global";
  assignedTo?: string[];
  canEdit: boolean;
  archived: boolean;
  updatedAt: string;
};
export type ContentPackage = PackageSummary & {
  instructions: string;
  runtime: { id: string; version: string } | null;
  files: LibraryFile[];
};
export type LibraryPage = {
  userId: string;
  packages: PackageSummary[];
  total: number;
  nextOffset: number | null;
};
export function listLibrary(query: string, scope: string, offset: number, signal?: AbortSignal) {
  return request<LibraryPage>(
    `/v1/library?${new URLSearchParams({ query, scope, offset: String(offset), limit: "50" })}`,
    { signal },
  );
}
export function readPackage(id: string, signal?: AbortSignal, version?: number) {
  return request<ContentPackage>(
    `/v1/library/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`,
    { signal },
  );
}
export function writePackage(id: string | null, body: unknown, action = "") {
  return request<ContentPackage>(
    `/v1/library${id ? `/${encodeURIComponent(id)}` : ""}${action ? `/${action}` : ""}`,
    {
      method: id && !action ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
export function fileUrl(id: string, file: string) {
  return apiUrl(`/v1/library/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`);
}
export async function fileBase64(file: File) {
  if (file.size > 16 * 1024 * 1024 || !file.size)
    throw new Error("Choose a nonempty file up to 16 MiB.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Unable to read this file. Try selecting it again."));
    reader.onabort = () => reject(new Error("File reading stopped."));
    reader.readAsDataURL(file);
  });
}
