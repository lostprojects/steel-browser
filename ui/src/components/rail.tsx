import { useEffect, useState } from "react";
import type { Tone } from "../format";
import {
  ArrowUpRightIcon,
  BookIcon,
  BranchIcon,
  RailIcon,
  ToolstackLogo,
  WindowIcon,
} from "./icons";
import type { View } from "./capabilities";

export type ApiStatus = "connecting" | "online" | "reconnecting" | "offline";

const problems: Partial<Record<ApiStatus, { label: string; tone: Tone }>> = {
  reconnecting: { label: "Reconnecting to the API…", tone: "yellow" },
  offline: { label: "Can't reach the API", tone: "red" },
};

const links = [
  {
    href: "https://github.com/lostprojects/toolstack/blob/main/USAGE.md",
    label: "Docs",
    icon: BookIcon,
  },
  { href: "https://github.com/lostprojects/toolstack", label: "GitHub", icon: BranchIcon },
];

export function Rail({
  status,
  onCollapse,
  view,
}: {
  status: ApiStatus;
  onCollapse: () => void;
  view: View;
}) {
  const problem = problems[status];
  const [team, setTeam] = useState(false);
  const [organization, setOrganization] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/v1/organization", { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          const value = await response.json();
          if (typeof value.organization?.name === "string")
            setOrganization(value.organization.name);
        }
      })
      .catch(() => {});
    void fetch("/v1/me", { signal: controller.signal })
      .then(async (response) => {
        if (response.ok && (await response.json()).userId) setTeam(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <aside className="rail" aria-label="Sidebar">
      <div className="rail-head">
        <span className="rail-brand">
          <ToolstackLogo className="rail-logo" />
          <span>Toolstack</span>
        </span>
        <button
          type="button"
          className="bar-button"
          aria-label="Collapse sidebar"
          aria-expanded={true}
          title="Collapse sidebar"
          onClick={onCollapse}
        >
          <RailIcon />
        </button>
      </div>
      {organization && (
        <div className="rail-organization" aria-label="Organization">
          <span>{organization}</span>
        </div>
      )}
      <nav className="rail-nav" aria-label="Main">
        <div className="rail-group">
          <p className="rail-group-title">My workspace</p>
          <div className="rail-items">
            {(
              [
                ["toolkits", "Toolkits", "⌘"],
                ["library", "Library", "▤"],
                ["connections", "Connections", "◇"],
                ["activity", "Activity", "◷"],
                ["browser", "Browser", "↗"],
              ] as const
            ).map(([id, label, symbol]) => (
              <a
                key={id}
                className="rail-item"
                href={`#/${id}`}
                aria-current={view === id ? "page" : undefined}
              >
                <span className="nav-symbol" aria-hidden="true">
                  {symbol}
                </span>
                <span className="rail-item-label">{label}</span>
              </a>
            ))}
            {team && (
              <a className="rail-item" href="/account">
                <WindowIcon />
                <span className="rail-item-label">Account & agent keys</span>
              </a>
            )}
          </div>
        </div>
        <div className="rail-group">
          <p className="rail-group-title">External</p>
          <div className="rail-items">
            {links.map(({ href, label, icon: Icon }) => (
              <a key={href} className="rail-item" href={href} target="_blank" rel="noreferrer">
                <Icon />
                <span className="rail-item-label">{label}</span>
                <ArrowUpRightIcon className="rail-item-trail" />
              </a>
            ))}
          </div>
        </div>
      </nav>
      {problem && (
        <div className="rail-foot">
          <div className="api-status" role="status" data-tone={problem.tone}>
            <span className="api-status-dot" />
            {problem.label}
          </div>
        </div>
      )}
    </aside>
  );
}
