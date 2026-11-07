import { useEffect, useRef, useState } from "react";
import { RailIcon } from "./icons";
import { request } from "../api";
import { CopyButton } from "./copy-button";
import {
  fileBase64,
  fileUrl,
  listLibrary,
  readPackage,
  writePackage,
  type ContentPackage,
  type PackageSummary,
  type LibraryPage,
} from "../library";

const blank = () => ({
  title: "",
  description: "",
  kind: "skill",
  instructions: "",
  runtime: null as ContentPackage["runtime"],
  files: [] as ContentPackage["files"],
});
const draftOf = (value: ContentPackage) => ({
  title: value.title,
  description: value.description,
  kind: value.kind,
  instructions: value.instructions,
  runtime: value.runtime,
  files: value.files,
});
type Draft = ReturnType<typeof blank>;

const scopeLabel = (value: string) =>
  value === "global" ? "Organization" : value === "assigned" ? "Selected teammates" : "Private";

export function Library({
  railOpen,
  onToggleRail,
}: {
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const [data, setData] = useState<LibraryPage>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("available");
  const [revision, setRevision] = useState(0);
  const [document, setDocument] = useState<ContentPackage | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [visibility, setVisibility] = useState<ContentPackage["visibility"]>("private");
  const [assignedTo, setAssignedTo] = useState("");
  const [history, setHistory] =
    useState<{ version: number; operation: string; createdAt: string }[]>();
  const [role, setRole] = useState("reference");
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message: string;
    label: string;
    run: () => void;
  }>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const readController = useRef<AbortController | null>(null);
  const requestKey = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const original = document ? draftOf(document) : blank();
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(original);
  const historical =
    !!document && document.version !== (document.latestVersion ?? document.version);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void listLibrary(query, scope, 0, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setData(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, revision]);
  useEffect(() => () => readController.current?.abort(), []);
  useEffect(() => {
    if (confirm) modal.current?.showModal();
    else modal.current?.close();
  }, [confirm]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigation = (event: Event) => {
      const detail = (event as CustomEvent<{ to: string }>).detail;
      event.preventDefault();
      setConfirm({
        title: "Discard unsaved changes?",
        message: "Your saved package will remain available.",
        label: "Discard changes",
        run: () => {
          setEditing(false);
          window.setTimeout(() => {
            window.location.hash = `/${detail.to}`;
          }, 0);
        },
      });
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("toolstack:before-navigate", navigation);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("toolstack:before-navigate", navigation);
    };
  }, [dirty]);
  function accept(value: ContentPackage) {
    setDocument(value);
    setDraft(draftOf(value));
    setEditing(value.canEdit);
    setVisibility(value.visibility);
    setAssignedTo((value.assignedTo ?? []).join(", "));
    setHistory(undefined);
    if (value.version === value.latestVersion)
      setData((current) =>
        current
          ? {
              ...current,
              packages: current.packages.map((item) => (item.id === value.id ? value : item)),
            }
          : current,
      );
    refresh();
  }
  async function select(item: PackageSummary | null, version?: number) {
    const load = async () => {
      readController.current?.abort();
      setError("");
      setNotice("");
      setHistory(undefined);
      if (!item) {
        setDocument(null);
        setDraft(blank());
        setEditing(true);
        setVisibility("private");
        setAssignedTo("");
        return;
      }
      const controller = new AbortController();
      readController.current = controller;
      setBusy(true);
      try {
        const value = await readPackage(item.id, controller.signal, version);
        if (!controller.signal.aborted) accept(value);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unable to load content.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    if (dirty)
      setConfirm({
        title: "Discard unsaved changes?",
        message: "Your saved package will remain available.",
        label: "Discard changes",
        run: () => {
          void load();
        },
      });
    else await load();
  }
  function key(body: unknown) {
    const fingerprint = JSON.stringify(body);
    if (requestKey.current?.fingerprint !== fingerprint)
      requestKey.current = { fingerprint, id: crypto.randomUUID() };
    return requestKey.current!.id;
  }
  async function mutate(body: Record<string, unknown>, action = "", message = "Saved") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await writePackage(
        document?.id ?? null,
        { ...body, requestId: key([document?.id, action, body]) },
        action,
      );
      accept(value);
      setNotice(message);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save. Retry with the same inputs.",
      );
    } finally {
      setBusy(false);
    }
  }
  const contentBody = () => ({
    ...draft,
    files: draft.files.map((file) => file.id),
    ...(document ? { expectedVersion: document.latestVersion ?? document.version } : {}),
  });
  async function upload(file: File) {
    if (!document) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const base64 = await fileBase64(file);
      await mutate(
        {
          expectedVersion: document.version,
          name: file.name,
          role,
          mediaType: file.type || "application/octet-stream",
          base64,
        },
        "files",
        "File stored and verified",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to upload file.");
    } finally {
      setBusy(false);
    }
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    const body = contentBody();
    if (!document) {
      const { files: _files, ...creation } = body;
      void mutate(creation);
    } else void mutate(body);
  }
  function share() {
    const body = {
      expectedVersion: document!.version,
      visibility,
      assignedTo:
        visibility === "assigned" ? [...new Set(assignedTo.split(/[,\s]+/).filter(Boolean))] : [],
    };
    setConfirm({
      title:
        visibility === "private"
          ? "Make this content private?"
          : "Change who can use this content?",
      message:
        visibility === "global"
          ? "Current and future active members of this organization will be able to read the current package and its files. Account permissions stay separate."
          : visibility === "assigned"
            ? "The selected people will receive access to the current package and its files. Account permissions stay separate."
            : "Other people will lose access through Toolstack. Files they already downloaded cannot be recalled.",
      label: "Apply sharing",
      run: () => {
        void mutate(body, "share", "Sharing updated");
      },
    });
  }
  return (
    <>
      <header className="top-bar catalog-bar">
        {!railOpen && (
          <button
            className="bar-button"
            type="button"
            aria-label="Expand sidebar"
            onClick={onToggleRail}
          >
            <RailIcon />
          </button>
        )}
        <div className="crumbs">Library</div>
        <div className="top-bar-actions">
          <button className="button" type="button" onClick={refresh} disabled={busy}>
            Refresh
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => {
              void select(null);
            }}
          >
            New package
          </button>
        </div>
      </header>
      <div className="catalog-body library-body">
        <div className="page-intro">
          <p className="eyebrow">Your content</p>
          <h1>Your methods, ready to use.</h1>
          <p className="muted">
            Keep your skills and tooling together. Share a package when someone else needs it.
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}{" "}
            <button
              className="text-button"
              type="button"
              onClick={() => (document ? void select(document) : refresh())}
            >
              {document ? "Reload package" : "Reload library"}
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="library-notice">
            {notice}
          </p>
        )}
        <div className="catalog-filters">
          <label className="search-field">
            <span className="sr-only">Search library</span>
            <input
              className="input"
              type="search"
              placeholder="Search your library…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Content scope</span>
            <select
              className="input"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="available">Available to me</option>
              <option value="mine">My content</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <span className="result-count" role="status">
            {loading
              ? "Loading…"
              : `${data?.total ?? 0} ${(data?.total ?? 0) === 1 ? "package" : "packages"}`}
          </span>
        </div>
        <div className="catalog-split library-split">
          <div className="tool-list" aria-label="Content packages">
            {data?.packages.map((item) => (
              <button
                type="button"
                className="tool-item library-package"
                key={item.id}
                disabled={busy}
                aria-pressed={document?.id === item.id}
                onClick={() => {
                  void select(item);
                }}
              >
                <span className="eyebrow">
                  {item.kind} · {scopeLabel(item.visibility)} · v{item.version}
                </span>
                <span className="tool-item-name">{item.title}</span>
                <span className="tool-item-description">
                  {item.description || `Owned by ${item.owner}`}
                </span>
              </button>
            ))}
            {data && !data.packages.length && (
              <div className="catalog-empty">
                <h2>
                  {query
                    ? "No matching content"
                    : scope === "archived"
                      ? "No archived packages"
                      : "Your library is ready"}
                </h2>
                <p className="muted">
                  {query
                    ? "Try a different search."
                    : "Create a package to keep its instructions and supporting files together."}
                </p>
              </div>
            )}
            {data?.nextOffset !== null && data?.nextOffset !== undefined && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const page = await listLibrary(query, scope, data.nextOffset!);
                    setData((current) =>
                      current
                        ? { ...page, packages: [...current.packages, ...page.packages] }
                        : page,
                    );
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Load more
              </button>
            )}
          </div>
          {editing || document ? (
            <section
              className="tool-detail library-editor"
              aria-label="Package editor"
              aria-busy={busy}
            >
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">
                    {document
                      ? `${scopeLabel(document.visibility)} · owner ${document.owner} · v${document.version}`
                      : "New private content"}
                  </p>
                  <h2>{document?.title ?? "New package"}</h2>
                </div>
                {dirty && <span className="version-label">Unsaved changes</span>}
                <CopyButton value={draft.instructions} label="Copy instructions" />
              </div>
              <form onSubmit={save}>
                <fieldset disabled={busy}>
                  <label className="library-field">
                    Title
                    <input
                      className="input"
                      name="title"
                      readOnly={!editing || historical || document?.archived}
                      required
                      maxLength={160}
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, title: event.target.value }))
                      }
                    />
                  </label>
                  <label className="library-field">
                    Description
                    <input
                      className="input"
                      name="description"
                      readOnly={!editing || historical || document?.archived}
                      maxLength={2000}
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, description: event.target.value }))
                      }
                    />
                  </label>
                  <label className="library-field">
                    Type
                    <select
                      disabled={!editing || historical || document?.archived}
                      className="input"
                      value={draft.kind}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, kind: event.target.value }))
                      }
                    >
                      <option value="skill">Skill</option>
                      <option value="toolkit">Tooling</option>
                      <option value="workflow">Workflow</option>
                    </select>
                  </label>
                  {editing && !historical && !document?.archived && (
                    <label className="library-field">
                      Import instructions
                      <input
                        className="input"
                        type="file"
                        accept=".md,.txt,text/markdown,text/plain"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          if (file.size > 200_000) {
                            setError("Choose an instruction file up to 200 KB.");
                            return;
                          }
                          try {
                            const instructions = await file.text();
                            setDraft((value) => ({ ...value, instructions }));
                            setNotice(
                              "Instructions imported into your draft. Save the package to keep them.",
                            );
                          } catch {
                            setError(
                              "Unable to read the instruction file. Try selecting it again.",
                            );
                          }
                        }}
                      />
                    </label>
                  )}
                  <label className="library-field">
                    Instructions
                    <textarea
                      className="input library-instructions"
                      name="instructions"
                      readOnly={!editing || historical || document?.archived}
                      maxLength={200_000}
                      value={draft.instructions}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, instructions: event.target.value }))
                      }
                    />
                  </label>
                  <p className="muted">
                    Store credentials in Connections. Uploaded scripts require a registered runtime
                    before they can execute.
                  </p>
                </fieldset>
                {editing && !historical && !document?.archived && (
                  <div className="library-actions">
                    <button
                      className="button primary"
                      type="submit"
                      disabled={busy || !draft.title.trim()}
                    >
                      {busy ? "Working…" : "Save package"}
                    </button>
                    {dirty && (
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: "Discard unsaved changes?",
                            message: "The saved version will remain available.",
                            label: "Discard changes",
                            run: () => setDraft(original),
                          })
                        }
                      >
                        Discard changes
                      </button>
                    )}
                  </div>
                )}
              </form>
              {document && (
                <>
                  <section className="library-section">
                    <h3>Files</h3>
                    {draft.files.length ? (
                      draft.files.map((file) => (
                        <div className="library-file" key={file.id}>
                          <div>
                            <a href={fileUrl(document.id, file.id)}>{file.name}</a>
                            <p className="muted">
                              {file.role} · {(file.bytes / 1024).toFixed(1)} KiB
                            </p>
                            <details>
                              <summary>Checksum</summary>
                              <code>{file.sha256}</code>
                            </details>
                          </div>
                          {editing && !historical && !document.archived && (
                            <button
                              className="text-button"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setDraft((value) => ({
                                  ...value,
                                  files: value.files.filter((item) => item.id !== file.id),
                                }))
                              }
                            >
                              Remove from draft
                            </button>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="muted">No files in this version.</p>
                    )}
                    {editing && !historical && !document.archived && (
                      <div className="library-upload">
                        <label>
                          File role
                          <select
                            className="input"
                            value={role}
                            disabled={busy || dirty}
                            onChange={(event) => setRole(event.target.value)}
                          >
                            <option value="reference">Reference</option>
                            <option value="script">Script</option>
                            <option value="asset">Asset</option>
                          </select>
                        </label>
                        <label>
                          Add a file
                          <input
                            className="input"
                            type="file"
                            disabled={busy || dirty}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void upload(file);
                              event.target.value = "";
                            }}
                          />
                        </label>
                        <p className="muted">
                          {dirty
                            ? "Save your changes before uploading."
                            : "Each upload creates a version and verifies its checksum. Maximum 16 MiB."}
                        </p>
                      </div>
                    )}
                  </section>
                  {editing && !historical && (
                    <section className="library-section">
                      <h3>Sharing</h3>
                      <label className="library-field">
                        Who can use this package?
                        <select
                          className="input"
                          value={visibility}
                          disabled={busy || dirty || document.archived}
                          onChange={(event) =>
                            setVisibility(event.target.value as ContentPackage["visibility"])
                          }
                        >
                          <option value="private">Only me</option>
                          <option value="assigned">Selected people</option>
                          <option value="global">Everyone in this organization</option>
                        </select>
                      </label>
                      {visibility === "assigned" && (
                        <label className="library-field">
                          Toolstack user IDs
                          <input
                            className="input"
                            value={assignedTo}
                            disabled={busy || dirty}
                            onChange={(event) => setAssignedTo(event.target.value)}
                            placeholder="Separate user IDs with commas"
                          />
                        </label>
                      )}
                      <button
                        className="button"
                        type="button"
                        disabled={busy || dirty || document.archived}
                        onClick={share}
                      >
                        Apply sharing
                      </button>
                    </section>
                  )}
                  {editing && (
                    <section className="library-section">
                      <h3>Versions and archive</h3>
                      <div className="library-actions">
                        <button
                          className="button"
                          type="button"
                          disabled={busy || dirty}
                          onClick={async () => {
                            try {
                              const result = await request<{
                                versions: NonNullable<typeof history>;
                              }>(`/v1/library/${document.id}/history`);
                              setHistory(result.versions);
                            } catch (cause) {
                              setError((cause as Error).message);
                            }
                          }}
                        >
                          Show versions
                        </button>
                        {historical && (
                          <button
                            className="button primary"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void mutate(contentBody(), "", "Version restored as a new revision");
                            }}
                          >
                            Restore this version
                          </button>
                        )}
                        {!historical && (
                          <button
                            className="button"
                            type="button"
                            disabled={busy || dirty}
                            onClick={() =>
                              setConfirm({
                                title: document.archived
                                  ? "Restore this package?"
                                  : "Archive this package?",
                                message: document.archived
                                  ? "The package will return with its previous sharing settings."
                                  : "Shared access will stop. Files and versions will be retained.",
                                label: document.archived ? "Restore" : "Archive",
                                run: () => {
                                  void mutate(
                                    {
                                      expectedVersion: document.version,
                                      archived: !document.archived,
                                    },
                                    "archive",
                                    document.archived ? "Package restored" : "Package archived",
                                  );
                                },
                              })
                            }
                          >
                            {document.archived ? "Restore package" : "Archive"}
                          </button>
                        )}
                      </div>
                      {history && (
                        <ol className="library-history">
                          {history.map((item) => (
                            <li key={item.version}>
                              <button
                                className="text-button"
                                type="button"
                                disabled={busy || dirty}
                                onClick={() => {
                                  void select(document, item.version);
                                }}
                              >
                                Version {item.version}
                              </button>{" "}
                              · {item.operation} · {new Date(item.createdAt).toLocaleString()}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  )}
                </>
              )}
            </section>
          ) : (
            <div className="catalog-empty">
              <h2>Choose a package</h2>
              <p className="muted">Read its method and supporting files, or create your own.</p>
            </div>
          )}
        </div>
      </div>
      <dialog ref={modal} className="library-confirm" onCancel={() => setConfirm(null)}>
        <h2>{confirm?.title}</h2>
        <p>{confirm?.message}</p>
        <div className="library-actions">
          <button className="button" type="button" onClick={() => setConfirm(null)}>
            Keep editing
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => {
              const run = confirm?.run;
              setConfirm(null);
              run?.();
            }}
          >
            {confirm?.label}
          </button>
        </div>
      </dialog>
    </>
  );
}
