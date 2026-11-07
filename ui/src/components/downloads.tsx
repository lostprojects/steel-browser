import { useEffect, useState } from "react";
import {
  apiUrl,
  getBrowserFiles,
  getDownloads,
  prepareDownload,
  shareDownload,
  type BrowserFile,
  type Download,
  type SessionDetails,
} from "../api";

export function Downloads({ session }: { session: SessionDetails }) {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [files, setFiles] = useState<BrowserFile[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const [prepared, raw] = await Promise.all([
          getDownloads(session.id, controller.signal),
          session.status === "live"
            ? getBrowserFiles(session.id, controller.signal)
            : Promise.resolve({ data: [] }),
        ]);
        if (controller.signal.aborted) return;
        setDownloads(prepared.data.filter((file) => ["receiving", "ready"].includes(file.state)));
        setFiles(raw.data);
        setLoaded(true);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError((failure as Error).message);
          setLoaded(true);
        }
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [session.id, session.status]);

  async function save(value: Download | BrowserFile) {
    setBusy("id" in value ? value.id : value.path);
    setError("");
    try {
      if (!("id" in value) && value.path.includes("/")) {
        window.location.assign(
          apiUrl(
            `/v1/sessions/${encodeURIComponent(session.id)}/files/${value.path.split("/").map(encodeURIComponent).join("/")}`,
          ),
        );
        return;
      }
      const prepared = "id" in value ? value : await prepareDownload(session.id, value.path);
      if (prepared.state !== "ready")
        throw new Error("The file is still being prepared. Try again shortly.");
      const shared = await shareDownload(session.id, prepared.id);
      window.location.assign(
        apiUrl(
          `/v1/sessions/${encodeURIComponent(session.id)}/transfers/${encodeURIComponent(shared.id)}/content`,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  const rows = [...downloads, ...files];
  return (
    <section className="downloads-panel" aria-label="Downloads">
      <h2>Downloads</h2>
      {error && <p role="alert">{error}</p>}
      {!error && !loaded && <p role="status">Checking for files…</p>}
      {loaded && !error && !rows.length && (
        <p>Files downloaded by this browser will appear here.</p>
      )}
      <ul>
        {rows.map((file) => {
          const id = "id" in file ? file.id : file.path;
          const waiting = "state" in file && file.state !== "ready";
          const bytes = "bytes" in file ? file.bytes : "size" in file ? file.size : undefined;
          return (
            <li key={id}>
              <span className="download-name">
                {file.name || ("path" in file ? file.path : "Download")}
              </span>
              <span className="download-size">
                {bytes === undefined
                  ? "Preparing…"
                  : new Intl.NumberFormat(undefined, {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(bytes) + " B"}
              </span>
              <button
                type="button"
                className="bar-button"
                disabled={waiting || !!busy}
                onClick={() => void save(file)}
              >
                {busy === id ? "Preparing…" : "Download"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
