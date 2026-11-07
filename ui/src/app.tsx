import { useState } from "react";
import { Notice } from "./components/notice";
import { Rail, type ApiStatus } from "./components/rail";
import { SessionConsole } from "./components/session-console";
import { Stage } from "./components/stage";
import { TopBar } from "./components/top-bar";
import { Downloads } from "./components/downloads";
import { useSessions, useShortcutKeys, useStoredToggle } from "./hooks";
import { Capabilities, useView } from "./components/capabilities";
import { Jobs } from "./components/jobs";
import { Library } from "./components/library";

export function App() {
  const view = useView();
  const { sessions, error, refresh } = useSessions(view === "browser" ? 2000 : 30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session =
    sessions === undefined
      ? undefined
      : (sessions.find((item) => item.id === selectedId) ??
        sessions.find((item) => item.status === "live") ??
        sessions[0] ??
        null);
  const [railOpen, toggleRail] = useStoredToggle("steel-browser:rail", true);
  const [consoleOpen, toggleConsole] = useStoredToggle("steel-browser:console", true);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  useShortcutKeys();

  const status: ApiStatus = error
    ? session
      ? "reconnecting"
      : "offline"
    : sessions === undefined
      ? "connecting"
      : "online";

  return (
    <div className="shell" data-rail={railOpen ? "open" : "closed"}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      {railOpen && <Rail status={status} onCollapse={toggleRail} view={view} />}
      <nav className="mobile-nav" aria-label="Workspace">
        {(["toolkits", "library", "jobs", "connections", "activity", "browser"] as const).map(
          (item) => (
            <a key={item} href={`#/${item}`} aria-current={view === item ? "page" : undefined}>
              {item[0]!.toUpperCase() + item.slice(1)}
            </a>
          ),
        )}
      </nav>
      <div className="body">
        <main className="panel" id="main-content" tabIndex={-1}>
          {view === "jobs" ? (
            <Jobs railOpen={railOpen} onToggleRail={toggleRail} />
          ) : view === "library" ? (
            <Library railOpen={railOpen} onToggleRail={toggleRail} />
          ) : view !== "browser" ? (
            <Capabilities
              key={view}
              view={view}
              railOpen={railOpen}
              onToggleRail={toggleRail}
              onOpenBrowser={(id) => {
                setSelectedId(id);
                refresh();
                window.location.hash = "/browser";
              }}
            />
          ) : (
            <>
              <TopBar
                session={session}
                sessions={sessions ?? []}
                onSelect={setSelectedId}
                railOpen={railOpen}
                onToggleRail={toggleRail}
                consoleOpen={consoleOpen}
                onToggleConsole={toggleConsole}
                downloadsOpen={downloadsOpen}
                onToggleDownloads={() => setDownloadsOpen((open) => !open)}
                onSessionChange={refresh}
                onStarted={(id) => {
                  setSelectedId(id);
                  refresh();
                }}
              />
              {session && downloadsOpen && <Downloads key={session.id} session={session} />}
              {session ? (
                <div className="workspace" key={session.id}>
                  <SessionConsole session={session} hidden={!consoleOpen} />
                  <Stage session={session} />
                </div>
              ) : error ? (
                <Notice title="Can't reach the Toolstack API">{error}</Notice>
              ) : session === null ? (
                <Notice title="No session">Use Start session to open a browser.</Notice>
              ) : (
                <Notice title="Connecting" busy />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
