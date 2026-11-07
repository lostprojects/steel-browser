import type { CreateSession, MultipleSessions, ReleaseSession, SessionDetails } from "./client";

export type { SessionDetails };

const apiBase = import.meta.env.VITE_API_URL ?? "";
const wsBase = import.meta.env.VITE_WS_URL ?? "";

export function apiUrl(path: string): string {
  return new URL(`${apiBase}${path}`, window.location.href).toString();
}

export function wsUrl(path: string): string {
  const url = new URL(`${wsBase}${path}`, window.location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      error?: string | { message?: string };
    } | null;
    throw Object.assign(
      new Error(
        typeof body?.message === "string"
          ? body.message
          : typeof body?.error === "string"
            ? body.error
            : (body?.error?.message ?? `Request failed (${response.status}). Try again.`),
      ),
      { status: response.status },
    );
  }
  return (await response.json()) as T;
}

export async function getSessions(signal: AbortSignal): Promise<SessionDetails[]> {
  const { sessions } = await request<MultipleSessions>("/v1/sessions", { signal });
  return sessions;
}

export function createSession(body: CreateSession): Promise<SessionDetails> {
  return request<SessionDetails>("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function releaseSession(id: string): Promise<ReleaseSession> {
  return request<ReleaseSession>(`/v1/sessions/${encodeURIComponent(id)}/release`, {
    method: "POST",
  });
}

export type Download = {
  id: string;
  session: string;
  name: string;
  state: string;
  bytes?: number;
  expiresAt: string;
  uri?: string;
  webUri?: string;
};
export type BrowserFile = { path: string; name?: string; size: number };
export function getDownloads(id: string, signal: AbortSignal) {
  return request<{ data: Download[] }>(`/v1/sessions/${encodeURIComponent(id)}/transfers`, {
    signal,
  }).catch((error) => {
    if (error.status === 410) return { data: [] };
    throw error;
  });
}
export function getBrowserFiles(id: string, signal: AbortSignal) {
  return request<{ data: BrowserFile[] }>(`/v1/sessions/${encodeURIComponent(id)}/files`, {
    signal,
  });
}
export function prepareDownload(id: string, file: string) {
  return request<Download>(`/v1/sessions/${encodeURIComponent(id)}/transfers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
}
export function shareDownload(id: string, transfer: string) {
  return request<Download>(
    `/v1/sessions/${encodeURIComponent(id)}/transfers/${encodeURIComponent(transfer)}/share`,
    { method: "POST" },
  );
}
