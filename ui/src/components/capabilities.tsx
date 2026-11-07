import { useCallback, useEffect, useRef, useState } from "react";
import { createSession } from "../api";
import {
  accountScope,
  changeAccess,
  configureConnection,
  getActivity,
  getCatalog,
  getConnections,
  getUsage,
  getWorkflow,
  getWorkflowReference,
  money,
  putCredential,
  statusLabel,
  verifyAccount,
  type Connection,
  type Toolkit,
  type Usage,
  type WorkflowSummary,
  type ToolResult,
} from "../catalog";
import { RailIcon } from "./icons";
import { ToolRunner } from "./tool-runner";
import { CopyButton } from "./copy-button";

export type View = "toolkits" | "library" | "connections" | "activity" | "browser";
export function useView() {
  const read = (): View => {
    const value = window.location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
    return ["toolkits", "library", "connections", "activity", "browser"].includes(value)
      ? (value as View)
      : "toolkits";
  };
  const [view, setView] = useState(read);
  const current = useRef(view);
  useEffect(() => {
    const update = () => {
      const next = read();
      if (next === current.current) return;
      const event = new CustomEvent("toolstack:before-navigate", {
        cancelable: true,
        detail: { to: next },
      });
      if (!window.dispatchEvent(event)) {
        window.history.replaceState(null, "", `#/${current.current}`);
        return;
      }
      current.current = next;
      setView(next);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return view;
}
function useResource<T>(load: (signal: AbortSignal) => Promise<T>, version: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unable to load. Try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [load, version]);
  return { data, error, busy };
}
const loadCatalog = async (signal: AbortSignal) => {
  const [catalog, connections] = await Promise.all([getCatalog(signal), getConnections(signal)]);
  return { ...catalog, ...connections };
};
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="catalog-empty">
      <div className="empty-symbol" aria-hidden="true">
        ＋
      </div>
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </div>
  );
}
export function Capabilities({
  view,
  railOpen,
  onToggleRail,
  onOpenBrowser,
}: {
  view: Exclude<View, "browser" | "library">;
  railOpen: boolean;
  onToggleRail: () => void;
  onOpenBrowser: (id: string) => void;
}) {
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((value) => value + 1);
  const { data, error, busy } = useResource(loadCatalog, version);
  const [query, setQuery] = useState("");
  const titles = { toolkits: "Toolkits", connections: "Connections", activity: "Activity" };
  return (
    <>
      <header className="top-bar catalog-bar">
        {!railOpen && (
          <button
            type="button"
            className="bar-button"
            aria-label="Expand sidebar"
            onClick={onToggleRail}
          >
            <RailIcon />
          </button>
        )}
        <div className="crumbs">
          <span>{titles[view]}</span>
        </div>
        <div className="top-bar-actions">
          <button type="button" className="button" disabled={busy} onClick={refresh}>
            {busy && data ? "Refreshing…" : "Refresh"}
          </button>
          {view === "connections" &&
            data?.toolkits.some((toolkit) =>
              toolkit.tools.some((tool) => tool.name === "connections_configure"),
            ) && (
              <NewConnection
                toolkits={data.toolkits}
                connections={data.connections}
                onSaved={refresh}
              />
            )}
        </div>
      </header>
      <div className="catalog-body" key={view}>
        <div className="page-intro">
          <p className="eyebrow">Your workspace</p>
          <h1>
            {view === "toolkits"
              ? "What would you like to do?"
              : view === "connections"
                ? "The right account for the work."
                : "Your work, in one place."}
          </h1>
          <p className="muted">
            {view === "toolkits"
              ? "Discover a capability, choose an account, and put it to work."
              : view === "connections"
                ? "Manage private profiles and permitted accounts. Credentials stay in the vault."
                : "Review API runs and browser sessions. Usage amounts are estimates, not invoices."}
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}{" "}
            <button className="text-button" type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {data && !data.sharedStoreAvailable && (
          <p className="inline-notice" role="status">
            Shared account metadata is unavailable. Private accounts are still available; refresh to
            check shared access.
          </p>
        )}
        {!data && !error ? (
          <div className="catalog-loading" role="status">
            <span className="spinner" /> Loading your workspace…
          </div>
        ) : data && view === "toolkits" ? (
          <ToolkitBrowser
            toolkits={data.toolkits}
            connections={data.connections}
            query={query}
            onQuery={setQuery}
            onExecuted={refresh}
          />
        ) : data && view === "connections" ? (
          <Connections
            connections={data.connections}
            version={version}
            onChanged={refresh}
            onOpenBrowser={onOpenBrowser}
          />
        ) : (
          view === "activity" && <ActivityView version={version} />
        )}
      </div>
    </>
  );
}
function ToolkitBrowser({
  toolkits,
  connections,
  query,
  onQuery,
  onExecuted,
}: {
  toolkits: Toolkit[];
  connections: Connection[];
  query: string;
  onQuery: (value: string) => void;
  onExecuted: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("browser_open");
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = toolkits
    .filter((toolkit) => !filter || toolkit.id === filter)
    .map((toolkit) => ({
      ...toolkit,
      tools: toolkit.tools.filter((tool) =>
        words.every((word) =>
          `${toolkit.name} ${tool.name} ${tool.description}`.toLocaleLowerCase().includes(word),
        ),
      ),
      workflows: (toolkit.workflows ?? []).filter((workflow) =>
        words.every((word) =>
          `${toolkit.name} ${workflow.name} ${workflow.description}`
            .toLocaleLowerCase()
            .includes(word),
        ),
      ),
    }))
    .filter((toolkit) => toolkit.tools.length || toolkit.workflows.length);
  const all = visible.flatMap((toolkit) => toolkit.tools);
  const methods = visible.flatMap((toolkit) => toolkit.workflows);
  const method =
    methods.find((item) => `workflow:${item.id}` === selected) ??
    (!all.length ? methods[0] : undefined);
  const tool = method ? undefined : (all.find((item) => item.name === selected) ?? all[0]);
  return (
    <>
      <div className="catalog-filters">
        <label className="search-field">
          <span className="sr-only">Search tools</span>
          <input
            className="input"
            type="search"
            placeholder="Search tools and capabilities…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Toolkit</span>
          <select
            className="input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">All toolkits</option>
            {toolkits.map((toolkit) => (
              <option key={toolkit.id} value={toolkit.id}>
                {toolkit.name}
              </option>
            ))}
          </select>
        </label>
        <span className="result-count" role="status">
          {all.length} {all.length === 1 ? "tool" : "tools"}
        </span>
      </div>
      {visible.length ? (
        <div className="catalog-split">
          <div className="tool-list" aria-label="Available tools and methods">
            {visible.map((toolkit) => (
              <section key={toolkit.id} className="toolkit-group">
                <div className="toolkit-heading">
                  <h2>{toolkit.name}</h2>
                  <span className="version-label">{toolkit.version}</span>
                </div>
                <p className="muted">{toolkit.description}</p>
                {toolkit.content && (
                  <p className="muted">
                    {toolkit.content.visibility === "private"
                      ? "Private content"
                      : toolkit.content.visibility === "assigned"
                        ? "Assigned content"
                        : "Global content"}
                    {" · "}Owner: {toolkit.content.owner}
                  </p>
                )}
                <div className="toolkit-tools">
                  {toolkit.workflows.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="tool-item method-item"
                      aria-pressed={method?.id === item.id}
                      onClick={() => setSelected(`workflow:${item.id}`)}
                    >
                      <span className="eyebrow">Working method</span>
                      <span className="tool-item-name">{item.name}</span>
                      <span className="tool-item-description">{item.description}</span>
                      <span className="tool-item-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  ))}
                  {toolkit.tools.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className="tool-item"
                      aria-pressed={tool?.name === item.name}
                      onClick={() => setSelected(item.name)}
                    >
                      <span className="tool-item-name">{item.name}</span>
                      <span className="tool-item-description">{item.description}</span>
                      <span className="tool-item-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {method ? (
            <WorkflowDetail key={`${method.id}:${method.version}`} method={method} />
          ) : (
            tool && (
              <ToolRunner
                key={`${tool.name}:${tool.version}`}
                tool={tool}
                connections={connections}
                onExecuted={onExecuted}
              />
            )
          )}
        </div>
      ) : (
        <Empty title="No matching tools">Try another search or select a different toolkit.</Empty>
      )}
    </>
  );
}
function WorkflowDetail({ method }: { method: WorkflowSummary }) {
  const load = useCallback(
    (signal: AbortSignal) => getWorkflow(method, signal),
    [method.id, method.version],
  );
  const { data, error } = useResource(load, 0);
  const [reference, setReference] = useState<{ id: string; content: string } | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [loadingReference, setLoadingReference] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const readReference = async (id: string) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoadingReference(true);
    setReferenceError(null);
    try {
      const result = await getWorkflowReference(method, id, request.signal);
      if (result.sha256 !== method.references.find((item) => item.id === id)?.sha256)
        throw new Error("The reference changed. Refresh this method before using it.");
      if (!request.signal.aborted) setReference({ id, content: result.content });
    } catch (failure) {
      if (!request.signal.aborted)
        setReferenceError(
          failure instanceof Error ? failure.message : "Unable to read the reference.",
        );
    } finally {
      if (!request.signal.aborted) setLoadingReference(false);
    }
  };
  return (
    <section className="tool-detail workflow-detail">
      <p className="eyebrow">Working method · {method.version}</p>
      <div className="detail-heading">
        <h2>{method.name}</h2>
        <CopyButton
          value={`Fetch Toolstack workflow ${method.id} at version ${method.version} with workflows_get, then follow its instructions using a permitted account. Ask me for any required inputs.`}
          label="Copy agent prompt"
        />
      </div>
      <p className="muted tool-description">{method.description}</p>
      <div className="tool-policy">
        <span className="status-pill">
          {method.policy.authority === "read" ? "Read only" : "Can make changes"}
        </span>
        <span>Use with your connected agent</span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && (
          <p className="muted" role="status">
            Loading the working method…
          </p>
        )
      ) : (
        <>
          <h3>Method</h3>
          <div className="workflow-instructions">{data.instructions}</div>
          <h3>Expected outputs</h3>
          <ul>
            {data.outputs.map((output) => (
              <li key={output}>{output}</li>
            ))}
          </ul>
          <h3>Completion checks</h3>
          <ul>
            {data.checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <details>
            <summary>Recovery and tool versions</summary>
            <p className="muted">{data.policy.retry}</p>
            <p className="muted">{data.policy.cancellation}</p>
            <ul>
              {data.dependencies.map((dependency) => (
                <li key={dependency.tool}>
                  <code>{dependency.tool}</code> · {dependency.version}
                </li>
              ))}
            </ul>
          </details>
          {data.references.length > 0 && (
            <section>
              <h3>Reference material</h3>
              <div className="reference-list">
                {data.references.map((item) => (
                  <button
                    type="button"
                    className="button"
                    disabled={loadingReference}
                    key={item.id}
                    onClick={() => void readReference(item.id)}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
              {referenceError && (
                <p className="inline-error" role="alert">
                  {referenceError}
                </p>
              )}
              {reference && (
                <pre className="reference-content" tabIndex={0}>
                  {reference.content}
                </pre>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
function Connections({
  connections,
  version,
  onChanged,
  onOpenBrowser,
}: {
  connections: Connection[];
  version: number;
  onChanged: () => void;
  onOpenBrowser: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const visible = connections.filter((account) =>
    `${account.label} ${account.toolkit ?? ""} ${account.id}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );
  const connection = visible.find((item) => item.id === selected) ?? visible[0];
  return (
    <>
      <div className="catalog-filters">
        <label className="search-field">
          <span className="sr-only">Search accounts</span>
          <input
            type="search"
            className="input"
            placeholder="Find an account…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <span className="result-count">
          {visible.length} {visible.length === 1 ? "account" : "accounts"}
        </span>
      </div>
      {!visible.length ? (
        <Empty title={connections.length ? "No matching accounts" : "Connect your first account"}>
          {connections.length
            ? "Try a different account name."
            : "Add an API account or a browser profile to start working with your tools."}
        </Empty>
      ) : (
        <div className="catalog-split connections-split">
          <div className="account-list">
            {visible.map((account) => (
              <button
                className="account-item"
                key={account.id}
                type="button"
                aria-pressed={connection?.id === account.id}
                onClick={() => setSelected(account.id)}
              >
                <span className="account-avatar" aria-hidden="true">
                  {account.type === "browser" ? "↗" : account.type === "api" ? "⌘" : "◇"}
                </span>
                <span className="account-summary">
                  <strong>{account.label}</strong>
                  <span>
                    {accountScope(account)} ·{" "}
                    {account.type === "api"
                      ? account.toolkit
                      : account.type === "browser"
                        ? "Browser"
                        : "Vault"}
                  </span>
                </span>
                <span className="status-pill" data-state={account.status}>
                  {statusLabel(account.status)}
                </span>
              </button>
            ))}
          </div>
          {connection && (
            <ConnectionDetail
              key={connection.id}
              connection={connection}
              version={version}
              onChanged={onChanged}
              onOpenBrowser={onOpenBrowser}
            />
          )}
        </div>
      )}
    </>
  );
}
function ConnectionDetail({
  connection,
  version,
  onChanged,
  onOpenBrowser,
}: {
  connection: Connection;
  version: number;
  onChanged: () => void;
  onOpenBrowser: (id: string) => void;
}) {
  const loadUsage = useCallback(
    (signal: AbortSignal) =>
      connection.type === "api" ? getUsage(connection.id, signal) : Promise.resolve(null),
    [connection.id, connection.type],
  );
  const { data: usage, error: usageError } = useResource(loadUsage, version);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [verification, setVerification] = useState<ToolResult | null>(null);
  const verificationKey = useRef(crypto.randomUUID());
  const action = async (run: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await run();
      onChanged();
      setConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update this account.");
    } finally {
      setPending(false);
    }
  };
  const disabled = ["disabled", "disconnected"].includes(connection.status);
  return (
    <section className="connection-detail">
      <p className="eyebrow">{accountScope(connection)}</p>
      <div className="detail-heading">
        <h2>{connection.label}</h2>
        <CopyButton value={connection.id} label="Copy connection ID" />
      </div>
      <p className="connection-id">{connection.id}</p>
      <span className="status-pill" data-state={connection.status}>
        {statusLabel(connection.status)}
      </span>
      {connection.type === "browser" && (
        <>
          <p className="muted">
            {connection.profileSaved
              ? "This profile has saved browser state."
              : "Browser state will be saved when you use this profile."}{" "}
            Authentication status describes the last recorded observation.
          </p>
          {connection.observations?.map((row) => (
            <div className="observation" key={row.site}>
              <span>{row.site}</span>
              <span>
                {statusLabel(row.status)} ·{" "}
                <time dateTime={row.observedAt}>{new Date(row.observedAt).toLocaleString()}</time>
              </span>
            </div>
          ))}
          <button
            className="button"
            data-variant="primary"
            disabled={!connection.permissions.canUse || pending || connection.busy}
            onClick={() =>
              void action(async () => {
                const opened = await createSession({
                  connection: connection.id,
                  caller: "toolstack-ui",
                });
                onOpenBrowser(opened.id);
              })
            }
          >
            {connection.busy ? "Profile in use" : pending ? "Opening…" : "Open browser"}
          </button>
        </>
      )}
      {connection.type === "api" && (
        <>
          <div className="connection-facts">
            <p>
              <span>Credential</span>
              <strong>{connection.credential?.name}</strong>
            </p>
            <p>
              <span>Permitted tools</span>
              <strong>{connection.allowedTools?.length ?? 0}</strong>
            </p>
          </div>
          {usageError && (
            <p className="inline-error" role="alert">
              {usageError}
            </p>
          )}
          {usage ? (
            <UsageMeters usage={usage} />
          ) : (
            !usageError && <p className="muted">Loading allowance…</p>
          )}
          <p className="muted">
            Configured status records the binding. Verification makes a provider request using the
            account's normal allowance.
          </p>
          <div className="run-actions">
            {connection.permissions.canVerify && (
              <button
                className="button"
                disabled={pending}
                onClick={() =>
                  void action(async () => {
                    const result = await verifyAccount(connection.id, verificationKey.current);
                    setVerification(result);
                    if (!result.isError) verificationKey.current = crypto.randomUUID();
                  })
                }
              >
                {pending
                  ? "Checking…"
                  : verification?.isError
                    ? "Retry verification"
                    : verification
                      ? "Verify again"
                      : "Verify account"}
                {connection.verification?.estimatedCostUSD
                  ? ` · up to ${money(connection.verification.estimatedCostUSD)}`
                  : ""}
              </button>
            )}
            <a className="button" href="#/toolkits">
              Browse tools
            </a>
          </div>
          {verification && (
            <section className="tool-result" aria-live="polite">
              <h3>
                {verification.isError
                  ? "Verification needs attention"
                  : "Provider verification result"}
              </h3>
              <pre tabIndex={0}>
                {verification.content
                  .filter((item) => item.type === "text")
                  .map((item) => {
                    try {
                      return JSON.stringify(JSON.parse(item.text ?? ""), null, 2);
                    } catch {
                      return item.text;
                    }
                  })
                  .join("\n")}
              </pre>
            </section>
          )}
        </>
      )}
      {connection.type === "vault" && (
        <p className="muted">
          This vault entry is available to permitted tools. Add an API connection or a supported
          browser mapping to use it.
        </p>
      )}
      {connection.permissions.allowedAgents && (
        <p className="field-help">
          Allowed agents: {connection.permissions.allowedAgents.join(", ")}
        </p>
      )}
      {connection.permissions.canConfigure && connection.type !== "vault" && (
        <section className="connection-controls">
          <h3>Account access</h3>
          <p className="muted">
            Access changes affect new use. Existing website sessions may remain active.
          </p>
          <div className="run-actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() =>
                void action(() => changeAccess(connection.id, disabled ? "enable" : "disable"))
              }
            >
              {disabled ? "Enable account" : "Disable account"}
            </button>
            {connection.status !== "disconnected" && (
              <button
                type="button"
                className="text-button danger-text"
                disabled={pending}
                onClick={() => setConfirm(true)}
              >
                Disconnect…
              </button>
            )}
          </div>
          {confirm && (
            <div className="inline-notice">
              <p>
                Disconnect this account binding? Saved credentials and browser profiles will remain
                available for reconnection. Revoke provider access separately.
              </p>
              <div className="run-actions">
                <button
                  className="button"
                  data-variant="danger"
                  disabled={pending}
                  onClick={() => void action(() => changeAccess(connection.id, "disconnect"))}
                >
                  Disconnect account
                </button>
                <button className="button" disabled={pending} onClick={() => setConfirm(false)}>
                  Keep connected
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
function UsageMeters({ usage }: { usage: Usage }) {
  return (
    <section className="usage-meters" aria-label="Daily allowance">
      <div className="form-heading">
        <h3>Today's allowance</h3>
        <span className="field-help">{usage.day} UTC</span>
      </div>
      <label>
        <span>{usage.remainingCalls} calls remaining</span>
        <span className="muted">
          {usage.calls} / {usage.limits.dailyCalls}
        </span>
        <meter
          min={0}
          max={usage.limits.dailyCalls}
          value={Math.min(usage.calls, usage.limits.dailyCalls)}
        />
      </label>
      <label>
        <span>{money(usage.remainingEstimatedUSD)} remaining</span>
        <span className="muted">
          {money(usage.accountedUSD)} / {money(usage.limits.dailyBudgetUSD)}
        </span>
        <meter
          min={0}
          max={usage.limits.dailyBudgetUSD}
          value={Math.min(usage.accountedUSD, usage.limits.dailyBudgetUSD)}
        />
      </label>
      <p className="field-help">
        Estimates include reservations for uncertain requests. The provider's bill may differ.
      </p>
    </section>
  );
}
function NewConnection({
  toolkits,
  connections,
  onSaved,
}: {
  toolkits: Toolkit[];
  connections: Connection[];
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const providers = toolkits.filter((toolkit) => toolkit.connection);
  const [kind, setKind] = useState("api");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((item) => item.id === providerId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCredential, setNewCredential] = useState(false);
  const credentialNames = [
    ...new Set(
      connections.flatMap((account) =>
        account.type === "vault"
          ? [account.id.slice(6)]
          : account.credential
            ? [account.credential.name]
            : [],
      ),
    ),
  ];
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? "").trim();
    const name = text("name"),
      label = text("label") || name;
    const id = `${kind === "api" ? "api" : "browser"}:${name}`;
    if (connections.some((account) => account.id === id)) {
      setError("That connection ID is already in use. Choose a new ID.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (kind === "api") {
        if (!provider?.connection) throw new Error("Select a registered API toolkit.");
        const credential = newCredential
          ? `${provider.id.slice(0, 20)}-${name.slice(0, 35)}-${crypto.randomUUID().slice(0, 6)}`
          : text("credential");
        if (!credential) throw new Error("Select a saved credential or add an API key.");
        if (newCredential && credentialNames.includes(credential))
          throw new Error(
            "That vault name already exists. Select its saved credential or use another connection ID.",
          );
        if (newCredential)
          await putCredential(
            credential,
            provider.connection.credentialFields[0]!,
            String(values.get("apiKey") ?? ""),
          );
        await configureConnection(id, {
          label,
          allowedAgents: ["admin"],
          api: {
            provider: provider.id,
            vault: credential,
            credentialField: provider.connection.credentialFields[0],
            allowedTools: provider.tools.map((tool) => tool.name),
            dailyCalls: Number(text("dailyCalls")),
            dailyBudgetUSD: Number(text("dailyBudgetUSD")),
            enabled: true,
          },
        });
      } else
        await configureConnection(id, {
          label,
          site: text("site") || null,
          allowedAgents: ["admin"],
        });
      form.reset();
      dialog.current?.close();
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save. Your credential may already be in the vault; refresh accounts before retrying.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <button
        className="button"
        data-variant="primary"
        type="button"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        Add connection
      </button>
      <dialog
        className="dialog"
        ref={dialog}
        aria-labelledby="add-connection-title"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClose={() => {
          setError(null);
          const secret = dialog.current?.querySelector<HTMLInputElement>('input[name="apiKey"]');
          if (secret) secret.value = "";
        }}
      >
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <div className="dialog-head">
            <h2 id="add-connection-title">Add a connection</h2>
            <p className="dialog-description">
              Choose the account and set a bounded daily allowance.
            </p>
          </div>
          <fieldset className="dialog-body" disabled={pending}>
            <label className="field">
              Connection type
              <select
                className="input"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="api">API account</option>
                <option value="browser">Browser profile</option>
              </select>
            </label>
            <label className="field">
              Connection ID
              <input
                className="input"
                name="name"
                required
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                maxLength={64}
                placeholder="research"
                autoComplete="off"
              />
            </label>
            <label className="field">
              Display name
              <input
                className="input"
                name="label"
                maxLength={100}
                placeholder="Research account"
              />
            </label>
            {kind === "api" ? (
              <>
                <label className="field">
                  Toolkit
                  <select
                    className="input"
                    value={providerId}
                    required
                    onChange={(event) => setProviderId(event.target.value)}
                  >
                    <option value="">Choose a toolkit</option>
                    {providers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Credential
                  <select
                    className="input"
                    value={newCredential ? "new" : "saved"}
                    onChange={(event) => setNewCredential(event.target.value === "new")}
                  >
                    <option value="saved">Use saved credential</option>
                    <option value="new">Add a personal API key</option>
                  </select>
                </label>
                {newCredential ? (
                  <label className="field">
                    API key
                    <input
                      className="input"
                      name="apiKey"
                      type="password"
                      required
                      maxLength={8192}
                      autoComplete="new-password"
                    />
                    <span className="field-help">
                      Stored in your encrypted vault. The form clears the key when you close it.
                    </span>
                  </label>
                ) : (
                  <label className="field">
                    Saved vault entry
                    <select className="input" name="credential" required>
                      <option value="">Select a credential</option>
                      {credentialNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="field-pair">
                  <label className="field">
                    Daily calls
                    <input
                      className="input"
                      name="dailyCalls"
                      type="number"
                      min={1}
                      max={1000}
                      defaultValue={20}
                      required
                    />
                  </label>
                  <label className="field">
                    Daily estimate, USD
                    <input
                      className="input"
                      name="dailyBudgetUSD"
                      type="number"
                      min={0.001}
                      max={100}
                      step="0.001"
                      defaultValue={0.1}
                      required
                    />
                  </label>
                </div>
              </>
            ) : (
              <label className="field">
                Default website
                <input
                  className="input"
                  type="url"
                  name="site"
                  placeholder="https://example.org/"
                />
                <span className="field-help">Open this profile to sign in and save its state.</span>
              </label>
            )}
            <p className="field-help">
              New connections are private to the worker administrator. Configure agent grants
              through the connection tools.
            </p>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </fieldset>
          <div className="dialog-foot">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button className="button" data-variant="primary" disabled={pending} type="submit">
              {pending ? "Saving…" : "Add connection"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
function ActivityView({ version }: { version: number }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback((signal: AbortSignal) => getActivity(offset, signal), [offset]);
  const { data, error, busy } = useResource(load, version);
  const [kind, setKind] = useState("all");
  return (
    <section className="activity-view">
      <div className="catalog-filters">
        <label>
          <span className="sr-only">Activity type</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All activity</option>
            <option value="api">API runs</option>
            <option value="browser">Browsers</option>
          </select>
        </label>
        <span className="field-help">
          API metadata retained for seven days · private to your worker
        </span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p className="muted" role="status">
          Loading activity…
        </p>
      ) : (
        <>
          {kind !== "browser" && (
            <section>
              <h2 className="section-title">API runs</h2>
              {!data.executions.length ? (
                <p className="quiet-empty">
                  Run a tool to see its outcome and estimated usage here.
                </p>
              ) : (
                <div className="activity-table-wrap">
                  <table className="activity-table" aria-label="API activity" role="table">
                    <thead>
                      <tr>
                        <th scope="col">Operation</th>
                        <th scope="col">Account</th>
                        <th scope="col">Outcome</th>
                        <th scope="col">Started</th>
                        <th scope="col">Estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.executions.map((row) => (
                        <tr key={row.id} role="row">
                          <td data-label="Operation" role="cell">
                            <details>
                              <summary>{row.tool}</summary>
                              <dl className="execution-details">
                                <dt>Execution</dt>
                                <dd>{row.id}</dd>
                                <dt>Version</dt>
                                <dd>{row.capabilityVersion ?? "Legacy"}</dd>
                                <dt>Cost basis</dt>
                                <dd>{row.costBasis.replaceAll("_", " ")}</dd>
                                {row.errorCode && (
                                  <>
                                    <dt>Issue</dt>
                                    <dd>{row.errorCode}</dd>
                                  </>
                                )}
                              </dl>
                              {row.state === "unknown" && (
                                <p className="field-help">
                                  The provider may have acted. Inspect the account before starting
                                  another operation.
                                </p>
                              )}
                            </details>
                          </td>
                          <td data-label="Account" role="cell">
                            {row.connection}
                          </td>
                          <td data-label="Outcome" role="cell">
                            <span className="status-pill" data-state={row.state}>
                              {statusLabel(row.state)}
                            </span>
                          </td>
                          <td data-label="Started" role="cell">
                            <time dateTime={row.startedAt}>
                              {new Date(row.startedAt).toLocaleString()}
                            </time>
                          </td>
                          <td data-label="Estimate" role="cell">
                            {money(row.accountedMicros / 1_000_000)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(offset > 0 || data.nextOffset !== null) && (
                <div className="pagination">
                  <button
                    className="button"
                    disabled={busy || offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    Previous
                  </button>
                  <span>{data.total} runs</span>
                  <button
                    className="button"
                    disabled={busy || data.nextOffset === null}
                    onClick={() => setOffset(data.nextOffset!)}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          )}
          {kind !== "api" && (
            <section>
              <h2 className="section-title">Browser sessions</h2>
              {!data.sessions.length ? (
                <p className="quiet-empty">Your browser sessions will appear here.</p>
              ) : (
                <ul className="session-activity">
                  {data.sessions.map((row) => (
                    <li key={row.id}>
                      <span>
                        <strong>{row.identity ?? row.site ?? "Temporary browser"}</strong>
                        <span className="field-help">
                          {row.mode} · {row.id.slice(0, 8)}
                          {row.endReason ? ` · ${row.endReason}` : ""}
                        </span>
                      </span>
                      <span className="status-pill" data-state={row.status}>
                        {statusLabel(row.status)}
                      </span>
                      <a href="#/browser" className="text-button">
                        Open workspace ↗
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
