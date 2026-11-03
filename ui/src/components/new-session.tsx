import { useRef, useState, type FormEvent } from "react";
import { createSession } from "../api";
import { KeyChip } from "./key-chip";

export function NewSessionButton({ onStarted }: { onStarted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim() || undefined;
    const width = text("width");
    const height = text("height");
    if (Boolean(width) !== Boolean(height)) {
      setError("Enter both width and height, or leave both empty.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      await createSession({
        dimensions: width && height ? { width: Number(width), height: Number(height) } : undefined,
        identity: text("identity"),
        proxyUrl: text("proxyUrl"),
        timezone: text("timezone"),
      });
      dialog.current?.close();
      form.reset();
      onStarted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-shortcut="s"
        aria-keyshortcuts="S"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        Start session
        <KeyChip k="S" />
      </button>
      <dialog
        ref={dialog}
        className="dialog"
        aria-labelledby="new-session-title"
        aria-describedby="new-session-description"
        onClose={() => setError(null)}
      >
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <div className="dialog-head">
            <h2 id="new-session-title" className="dialog-title">
              Start a new session
            </h2>
            <p id="new-session-description" className="dialog-description">
              Start an independent browser. Use a named profile to retain its saved state.
            </p>
          </div>
          <div className="dialog-body">
            <div className="field" role="group" aria-labelledby="viewport-label">
              <span id="viewport-label">Viewport</span>
              <div className="viewport-inputs">
                <input
                  className="input"
                  name="width"
                  type="number"
                  inputMode="numeric"
                  min={320}
                  max={3840}
                  placeholder="1920"
                  aria-label="Width"
                />
                <span aria-hidden="true">×</span>
                <input
                  className="input"
                  name="height"
                  type="number"
                  inputMode="numeric"
                  min={240}
                  max={2160}
                  placeholder="1080"
                  aria-label="Height"
                />
              </div>
              <p className="field-hint">Leave empty to use the default size.</p>
            </div>
            <label className="field">
              <span>Profile name</span>
              <input
                className="input"
                name="identity"
                placeholder="Temporary profile"
                pattern="[a-zA-Z0-9]([a-zA-Z0-9_]|-){0,63}"
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Proxy URL</span>
              <input
                className="input"
                name="proxyUrl"
                type="url"
                placeholder="http://user:pass@host:port"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Timezone</span>
              <input
                className="input"
                name="timezone"
                placeholder="America/New_York"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="field-hint">
                Use the timezone of the proxy exit when supplying a proxy.
              </p>
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" className="button" data-variant="primary" disabled={pending}>
              {pending ? "Starting session…" : "Start session"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
