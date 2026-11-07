import type { SessionDetails } from "../api";
import { CopyButton } from "./copy-button";
import { ConsoleIcon, RailIcon } from "./icons";
import { NewSessionButton } from "./new-session";
import { ReleaseButton } from "./release-button";

export function TopBar({
  session,
  sessions,
  onSelect,
  railOpen,
  onToggleRail,
  consoleOpen,
  onToggleConsole,
  downloadsOpen,
  onToggleDownloads,
  onSessionChange,
  onStarted,
}: {
  session: SessionDetails | null | undefined;
  sessions: SessionDetails[];
  onSelect: (id: string) => void;
  railOpen: boolean;
  onToggleRail: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  downloadsOpen: boolean;
  onToggleDownloads: () => void;
  onSessionChange: () => void;
  onStarted: (id: string) => void;
}) {
  const consoleLabel = consoleOpen ? "Hide logs" : "Show logs";
  return (
    <header className="top-bar">
      {!railOpen && (
        <button
          type="button"
          className="bar-button rail-toggle"
          aria-label="Expand sidebar"
          aria-expanded={false}
          title="Expand sidebar"
          onClick={onToggleRail}
        >
          <RailIcon />
        </button>
      )}
      {session && (
        <button
          type="button"
          className="bar-button"
          aria-label={consoleLabel}
          aria-pressed={consoleOpen}
          title={consoleLabel}
          onClick={onToggleConsole}
        >
          <ConsoleIcon />
        </button>
      )}
      <div className="crumbs">
        <label className="crumb-parent" htmlFor="session-picker">
          Sessions
        </label>
        {session && (
          <>
            <select
              id="session-picker"
              className="input session-picker"
              aria-label="Selected session"
              value={session.id}
              onChange={(event) => onSelect(event.target.value)}
            >
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.identity ?? item.site ?? item.mode} · {item.id.slice(0, 8)} · {item.status}
                </option>
              ))}
            </select>
            <CopyButton className="crumb-copy" value={session.id} label="Copy session ID" />
          </>
        )}
      </div>
      <div className="top-bar-actions">
        {session && (
          <button
            type="button"
            className="bar-button"
            aria-pressed={downloadsOpen}
            onClick={onToggleDownloads}
          >
            Downloads
          </button>
        )}
        {session?.status === "live" && (
          <ReleaseButton key={session.id} sessionId={session.id} onReleased={onSessionChange} />
        )}
        <NewSessionButton onStarted={onStarted} />
      </div>
    </header>
  );
}
