import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiUrl } from "../api";
import {
  accountScope,
  runTool,
  type Connection,
  type JsonSchema,
  type Tool,
  type ToolResult,
} from "../catalog";
import { CopyButton } from "./copy-button";

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref?.startsWith("#/")) return schema;
  const segments = schema.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value: unknown = root;
  for (const key of segments)
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return value && typeof value === "object" ? (value as JsonSchema) : schema;
}
function initial(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
      const resolved = resolve(field, schema);
      return resolved.default === undefined
        ? []
        : [[key, complex(resolved) ? JSON.stringify(resolved.default, null, 2) : resolved.default]];
    }),
  );
}
function complex(schema: JsonSchema) {
  return schema.type === "object" || schema.type === "array" || !!schema.anyOf || !!schema.oneOf;
}
function parseFields(schema: JsonSchema, values: Record<string, unknown>) {
  const args = { ...values },
    errors: Record<string, string> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (complex(resolve(field, schema)) && typeof args[name] === "string") {
      try {
        args[name] = JSON.parse(args[name] as string);
      } catch {
        errors[name] = "Enter valid JSON or clear this field. Put text in double quotes.";
      }
    }
  }
  return { args, errors };
}
function resultText(result: ToolResult) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => {
      try {
        return JSON.stringify(JSON.parse(part.text ?? ""), null, 2);
      } catch {
        return part.text ?? "";
      }
    })
    .join("\n\n");
}
function safeLink(uri: string) {
  try {
    const url = new URL(uri, apiUrl("/"));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function ToolRunner({
  tool,
  connections,
  onExecuted,
}: {
  tool: Tool;
  connections: Connection[];
  onExecuted: () => void;
}) {
  const prefix = useId();
  const [values, setValues] = useState<Record<string, unknown>>(() => initial(tool.inputSchema));
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(initial(tool.inputSchema), null, 2));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ToolResult | null>(null);
  const renderedResult = useMemo(() => (result ? resultText(result) : ""), [result]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [inputChanged, setInputChanged] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const retry = useRef<string>(crypto.randomUUID());
  useEffect(() => () => controller.current?.abort(), []);
  const properties = tool.inputSchema.properties ?? {};
  const allowed = connections.filter(
    (account) =>
      account.permissions.canUse &&
      (account.type === "api"
        ? account.toolkit === tool.toolkit && account.allowedTools?.includes(tool.name)
        : account.type === "browser" && tool.toolkit === "browser"),
  );
  const needsAccount = !!properties.connection && tool.inputSchema.required?.includes("connection");
  const update = (name: string, value: unknown) => {
    setInputChanged(true);
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
    retry.current = crypto.randomUUID();
    setErrors((current) => ({ ...current, [name]: "" }));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    let args = values;
    try {
      if (advanced) {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Arguments must be a JSON object.");
        args = parsed as Record<string, unknown>;
      } else {
        const parsed = parseFields(tool.inputSchema, values);
        args = parsed.args;
        if (Object.keys(parsed.errors).length) {
          setErrors(parsed.errors);
          document.getElementById(`${prefix}-${Object.keys(parsed.errors)[0]}`)?.focus();
          return;
        }
      }
      if (properties.idempotencyKey && !args.idempotencyKey)
        args = { ...args, idempotencyKey: retry.current };
      controller.current = new AbortController();
      setRunning(true);
      const reply = await runTool(tool, args, controller.current.signal);
      setResult(reply);
      setInputChanged(false);
      onExecuted();
    } catch (failure) {
      setError(
        controller.current?.signal.aborted
          ? "Stopped waiting. The operation may already have acted. Check Activity before starting a new run; retry keeps the same operation key."
          : failure instanceof Error
            ? failure.message
            : "Unable to run this tool.",
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <section className="tool-detail" aria-labelledby={`${prefix}-title`}>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">
            {tool.toolkit} · {tool.version}
          </p>
          <h2 id={`${prefix}-title`}>{tool.name.replaceAll("_", " ")}</h2>
        </div>
        <CopyButton value={tool.name} label="Copy tool name" />
      </div>
      <p className="muted tool-description">{tool.description}</p>
      <div className="tool-policy">
        <span className="status-pill">
          {tool.annotations?.readOnlyHint ? "Read only" : "Can make changes"}
        </span>
        <span>{tool.authentication}</span>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-heading">
          <h3>Inputs</h3>
          <button
            type="button"
            className="text-button"
            disabled={running}
            onClick={() => {
              if (!advanced) {
                const parsed = parseFields(tool.inputSchema, values);
                if (Object.keys(parsed.errors).length) {
                  setErrors(parsed.errors);
                  return;
                }
                setJson(JSON.stringify(parsed.args, null, 2));
              } else {
                try {
                  const parsed = JSON.parse(json);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                    setValues(
                      Object.fromEntries(
                        Object.entries(parsed).map(([name, value]) => [
                          name,
                          complex(resolve(properties[name] ?? {}, tool.inputSchema))
                            ? JSON.stringify(value, null, 2)
                            : value,
                        ]),
                      ),
                    );
                  else {
                    setError("Arguments must be a JSON object.");
                    return;
                  }
                } catch {
                  setError("Fix the JSON before switching to fields.");
                  return;
                }
              }
              setAdvanced(!advanced);
            }}
          >
            {advanced ? "Use fields" : "Edit JSON"}
          </button>
        </div>
        <fieldset disabled={running} className="tool-fields">
          {advanced ? (
            <label className="field-label" htmlFor={`${prefix}-json`}>
              Arguments
              <textarea
                className="input code-input"
                id={`${prefix}-json`}
                rows={14}
                value={json}
                spellCheck={false}
                onChange={(event) => {
                  setJson(event.target.value);
                  retry.current = crypto.randomUUID();
                  setInputChanged(true);
                }}
              />
            </label>
          ) : (
            Object.entries(properties)
              .filter(([name]) => name !== "idempotencyKey")
              .map(([name, field]) => {
                const spec = resolve(field, tool.inputSchema);
                const required = tool.inputSchema.required?.includes(name) ?? false;
                const value = values[name];
                const id = `${prefix}-${name}`;
                const common = {
                  id,
                  className: "input",
                  required,
                  "aria-invalid": !!errors[name],
                  "aria-describedby": spec.description || errors[name] ? `${id}-help` : undefined,
                };
                const jsonField = complex(spec);
                return (
                  <div className="field" key={name}>
                    <label className="field-label" htmlFor={id}>
                      {name.replaceAll("_", " ")}
                      {!required && <span className="optional">Optional</span>}
                    </label>
                    {name === "connection" ? (
                      <select
                        {...common}
                        value={String(value ?? "")}
                        onChange={(event) => update(name, event.target.value || undefined)}
                      >
                        <option value="">
                          {required ? "Select an account" : "Default account"}
                        </option>
                        {allowed.map((account) => (
                          <option value={account.id} key={account.id}>
                            {account.label} · {accountScope(account)}
                          </option>
                        ))}
                      </select>
                    ) : spec.enum ? (
                      <select
                        {...common}
                        value={value === undefined ? "" : JSON.stringify(value)}
                        onChange={(event) =>
                          update(
                            name,
                            event.target.value ? JSON.parse(event.target.value) : undefined,
                          )
                        }
                      >
                        <option value="">{required ? "Choose…" : "Default"}</option>
                        {spec.enum.map((choice) => (
                          <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                            {String(choice)}
                          </option>
                        ))}
                      </select>
                    ) : spec.type === "boolean" ? (
                      <select
                        {...common}
                        value={value === undefined ? "" : String(value)}
                        onChange={(event) =>
                          update(
                            name,
                            event.target.value === "" ? undefined : event.target.value === "true",
                          )
                        }
                      >
                        <option value="">Default</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : jsonField ? (
                      <textarea
                        {...common}
                        className="input code-input"
                        rows={4}
                        value={
                          value === undefined
                            ? ""
                            : typeof value === "string"
                              ? value
                              : JSON.stringify(value, null, 2)
                        }
                        spellCheck={false}
                        placeholder={spec.type === "array" ? "[]" : "JSON value"}
                        onChange={(event) => update(name, event.target.value || undefined)}
                      />
                    ) : (
                      <input
                        {...common}
                        type={
                          spec.type === "number" || spec.type === "integer"
                            ? "number"
                            : spec.format === "uri"
                              ? "url"
                              : "text"
                        }
                        step={spec.type === "integer" ? 1 : "any"}
                        min={spec.minimum}
                        max={spec.maximum}
                        minLength={spec.minLength}
                        maxLength={spec.maxLength}
                        value={typeof value === "string" || typeof value === "number" ? value : ""}
                        onChange={(event) =>
                          update(
                            name,
                            event.target.value === ""
                              ? undefined
                              : spec.type === "number" || spec.type === "integer"
                                ? event.target.valueAsNumber
                                : event.target.value,
                          )
                        }
                      />
                    )}
                    {(spec.description || errors[name]) && (
                      <p id={`${id}-help`} className={errors[name] ? "field-error" : "field-help"}>
                        {errors[name] || spec.description}
                      </p>
                    )}
                  </div>
                );
              })
          )}
        </fieldset>
        {needsAccount && !allowed.length && (
          <p className="inline-notice">
            Add a permitted account in <a href="#/connections">Connections</a> to run this tool.
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="run-actions">
          <button
            className="button"
            data-variant="primary"
            disabled={running || (!!needsAccount && !allowed.length)}
            type="submit"
          >
            {running ? "Running…" : result && !inputChanged ? "Retry this run" : "Run tool"}
          </button>
          {running ? (
            <button type="button" className="button" onClick={() => controller.current?.abort()}>
              Stop waiting
            </button>
          ) : (
            result && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  retry.current = crypto.randomUUID();
                  setResult(null);
                  setError(null);
                }}
              >
                New run
              </button>
            )
          )}
        </div>
      </form>
      {result && (
        <section className="tool-result" aria-label="Tool result" aria-live="polite">
          <div className="form-heading">
            <h3>
              {inputChanged ? "Previous result" : result.isError ? "Run needs attention" : "Result"}
            </h3>
            <CopyButton value={renderedResult} label="Copy result" />
          </div>
          <pre tabIndex={0}>{renderedResult}</pre>
          {result.content
            .filter(
              (part) =>
                part.type === "image" &&
                part.data &&
                ["image/png", "image/jpeg", "image/webp"].includes(part.mimeType ?? ""),
            )
            .map((part, index) => (
              <img
                key={index}
                src={`data:${part.mimeType};base64,${part.data}`}
                alt="Tool output"
              />
            ))}
          {result.content
            .filter((part) => part.type === "resource_link" && part.uri)
            .map((part, index) => {
              const uri = safeLink(part.uri!);
              return uri ? (
                <a className="button" key={index} href={uri} target="_blank" rel="noreferrer">
                  {part.name ?? "Open output"}
                </a>
              ) : null;
            })}
        </section>
      )}
    </section>
  );
}
