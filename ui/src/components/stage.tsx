import { useEffect, useMemo, useRef } from "react";
import type { SessionDetails } from "../api";
import { useColorScheme } from "../hooks";
import { Details } from "./details";
import { Notice } from "./notice";

type BridgeMessage = {
  type?: string;
  requestId?: string;
  text?: string;
};

function LiveFrame({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useColorScheme();

  const src = useMemo(() => {
    const target = new URL(url, window.location.href);
    target.searchParams.set("theme", theme);
    target.searchParams.set("clipboardBridge", "true");
    return target;
  }, [url, theme]);

  useEffect(() => {
    const origin = src.origin;
    const post = (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage(message, origin);

    const onMessage = async (event: MessageEvent<BridgeMessage | null>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const { type, requestId, text } = event.data ?? {};
      if (type === "requestClipboardRead") {
        try {
          const value = await navigator.clipboard.readText();
          post({ type: "clipboardReadResponse", requestId, text: value });
        } catch {
          post({ type: "clipboardReadResponse", requestId, error: "Failed to read clipboard" });
        }
      } else if (type === "requestClipboardWrite") {
        try {
          await navigator.clipboard.writeText(text ?? "");
          post({ type: "clipboardWriteResponse", requestId, success: true });
        } catch {
          post({
            type: "clipboardWriteResponse",
            requestId,
            success: false,
            error: "Failed to write to clipboard",
          });
        }
      }
    };

    const onKeyDown = async (event: KeyboardEvent) => {
      if (!container.current?.contains(document.activeElement)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        post({ type: "triggerCopy" });
      } else if (key === "v") {
        event.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (text) post({ type: "triggerPaste", text });
        } catch {
          return;
        }
      }
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [src]);

  return (
    <div ref={container} className="player" tabIndex={0}>
      <iframe
        ref={frame}
        src={src.toString()}
        title="Live browser"
        className="live-frame"
        sandbox="allow-same-origin allow-scripts"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export function Stage({ session }: { session: SessionDetails }) {
  const starting = session.status === "starting";
  const live = session.status === "live";
  return (
    <section className="stage" aria-label="Live view">
      {session.status === "live" && session.viewAvailable && session.debugUrl ? (
        <LiveFrame url={session.debugUrl} />
      ) : (
        <div className="player">
          <Notice
            title={starting ? "Starting session" : live ? "Protected profile" : "Session ended"}
          >
            {starting
              ? "The browser is starting."
              : live
              ? "Live viewing is unavailable for this profile."
              : "Saved session details are shown below."}
          </Notice>
        </div>
      )}
      <div className="stage-details">
        <Details session={session} />
      </div>
    </section>
  );
}
