import { useEffect, useRef, useState } from "react";
import { RailIcon } from "./icons";
import {
  cancelJob,
  jobResult,
  listJobs,
  readJob,
  removeJobResult,
  type Job,
  type JobPage,
} from "../jobs";
const active = (job: Job) => ["queued", "running", "retrying"].includes(job.state);
const stateLabel = (job: Job) =>
  ({
    queued: "Queued",
    running: "Running",
    retrying: "Retrying",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  })[job.state];
const selectedFromUrl = () =>
  window.location.hash.match(/^#\/?jobs\/([a-f0-9-]{36})$/)?.[1] ?? null;
export function Jobs({ railOpen, onToggleRail }: { railOpen: boolean; onToggleRail: () => void }) {
  const [page, setPage] = useState<JobPage>(),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [id, setId] = useState<string | null>(selectedFromUrl),
    [job, setJob] = useState<Job>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"cancel" | "remove" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
  useEffect(() => {
    const change = () => setId(selectedFromUrl());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const refresh = async () => {
      if (controller.signal.aborted || document.visibilityState === "hidden" || loading) return;
      loading = true;
      try {
        const [next, selected] = await Promise.all([
          listJobs(offset, controller.signal),
          id ? readJob(id, controller.signal) : undefined,
        ]);
        if (!controller.signal.aborted) {
          setPage(next);
          setJob(selected);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unable to load jobs");
      } finally {
        loading = false;
        clearTimeout(timer);
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [id, offset, revision]);
  const select = (value: Job) => {
    setId(value.id);
    setJob(value);
    window.history.replaceState(null, "", `#/jobs/${value.id}`);
  };
  const stop = async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      setJob(await (confirm === "remove" ? removeJobResult(job.id) : cancelJob(job.id)));
      setConfirm(null);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel the job");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className="top-bar">
        <div className="top-bar-leading">
          {!railOpen && (
            <button className="bar-button" aria-label="Open sidebar" onClick={onToggleRail}>
              <RailIcon />
            </button>
          )}
          <div className="crumbs">Jobs</div>
        </div>
        <div className="top-bar-actions">
          <button className="button" onClick={() => setRevision((v) => v + 1)}>
            Refresh
          </button>
        </div>
      </header>
      <div className="catalog-body jobs-body">
        <div className="page-intro">
          <p className="eyebrow">Your background work</p>
          <h1>Start it. Come back to the result.</h1>
          <p className="muted">
            Jobs continue when you leave the app. Export a saved package from Library to get
            started.
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}{" "}
            <button className="button" onClick={() => setRevision((v) => v + 1)}>
              Try again
            </button>
          </div>
        )}
        {page && !page.workerAvailable && (
          <p className="job-worker-note" role="status">
            The executor is reconnecting. Queued work is saved and will start when it returns.
          </p>
        )}
        {!page && !error && (
          <p role="status" className="muted">
            Loading jobs…
          </p>
        )}
        {page && (
          <div className="jobs-layout">
            <section aria-label="Your jobs">
              <div className="job-list-heading">
                <span className="muted" role="status">
                  {page.total} {page.total === 1 ? "job" : "jobs"}
                </span>
                <a className="button" href="#/library">
                  Open Library
                </a>
              </div>
              {!page.jobs.length ? (
                <div className="empty-state">
                  <h2>No jobs yet</h2>
                  <p>
                    Open one of your saved packages and choose Export saved version. Its progress
                    and download will appear here.
                  </p>
                </div>
              ) : (
                <div className="job-list">
                  {page.jobs.map((item) => (
                    <button
                      key={item.id}
                      className={`job-card ${id === item.id ? "selected" : ""}`}
                      aria-pressed={id === item.id}
                      onClick={() => select(item)}
                    >
                      <span className="job-card-top">
                        <span className={`job-state state-${item.state}`}>{stateLabel(item)}</span>
                        <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
                      </span>
                      <strong>{item.title}</strong>
                      <span className="muted">Package export · Version {item.version}</span>
                      {active(item) && (
                        <progress
                          max="100"
                          value={item.progress}
                          aria-label={`${item.title} progress`}
                        />
                      )}
                      <span className="job-card-stage">{item.stage}</span>
                    </button>
                  ))}
                </div>
              )}
              {(offset > 0 || page.nextOffset !== null) && (
                <div className="library-actions">
                  <button
                    className="button"
                    disabled={!offset}
                    onClick={() => setOffset((v) => Math.max(0, v - 20))}
                  >
                    Previous
                  </button>
                  <button
                    className="button"
                    disabled={page.nextOffset === null}
                    onClick={() => setOffset(page.nextOffset!)}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
            <section className="job-detail" aria-label="Selected job">
              {!job ? (
                <div className="empty-state">
                  <h2>Choose a job</h2>
                  <p>See its progress, cancel work or download a completed result.</p>
                </div>
              ) : (
                <>
                  <p className="eyebrow">Package export · Version {job.version}</p>
                  <h2>{job.title}</h2>
                  <p className={`job-state state-${job.state}`} role="status">
                    {stateLabel(job)} · {job.stage}
                  </p>
                  {active(job) && (
                    <>
                      <progress max="100" value={job.progress} aria-label="Job progress" />
                      <p className="muted">
                        {job.progress}% complete ·{" "}
                        {job.attempts ? `Attempt ${job.attempts}` : "Waiting to start"}
                      </p>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => setConfirm("cancel")}
                      >
                        Cancel job
                      </button>
                    </>
                  )}
                  {job.error && (
                    <p className="inline-error" role="alert">
                      {job.error}
                    </p>
                  )}
                  {job.resultAvailable && (
                    <>
                      <div className="library-actions">
                        <a className="button" data-variant="primary" href={jobResult(job.id)}>
                          Download ZIP
                        </a>
                        <button className="button" onClick={() => setConfirm("remove")}>
                          Remove result
                        </button>
                      </div>
                      <p className="muted">
                        Instructions, package metadata and supporting files. The encrypted result is
                        kept for seven days.
                      </p>
                    </>
                  )}
                  {job.state === "completed" && !job.resultAvailable && (
                    <p className="muted">
                      This result is no longer available. Return to Library to start another export.
                    </p>
                  )}
                  {["failed", "cancelled"].includes(job.state) && (
                    <a className="button" href="#/library">
                      Return to Library
                    </a>
                  )}
                  <dl className="job-facts">
                    <dt>Submitted</dt>
                    <dd>{new Date(job.createdAt).toLocaleString()}</dd>
                    {job.finishedAt && (
                      <>
                        <dt>Finished</dt>
                        <dd>{new Date(job.finishedAt).toLocaleString()}</dd>
                      </>
                    )}
                  </dl>
                </>
              )}
            </section>
          </div>
        )}
      </div>
      <dialog
        className="library-confirm"
        ref={dialog}
        onCancel={() => setConfirm(null)}
        aria-labelledby="cancel-job-title"
      >
        <h2 id="cancel-job-title">
          {confirm === "remove" ? "Remove this result?" : "Cancel this job?"}
        </h2>
        <p>
          {confirm === "remove"
            ? "The download will become unavailable. You can export the saved package again."
            : "The current export will stop. Your saved Library package will stay available."}
        </p>
        <div className="library-actions">
          <button className="button" disabled={busy} onClick={() => setConfirm(null)}>
            {confirm === "remove" ? "Keep result" : "Keep running"}
          </button>
          <button className="button" data-variant="danger" disabled={busy} onClick={() => void stop()}>
            {busy ? "Saving…" : confirm === "remove" ? "Remove result" : "Cancel job"}
          </button>
        </div>
      </dialog>
    </>
  );
}
