type OpenApiDocument = {
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, unknown>;
  components?: unknown;
  definitions?: unknown;
};

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const json = (value: unknown) => `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;

// Render the generated OpenAPI document without scripts or external resources.
export function renderApiReference(document: OpenApiDocument): string {
  const operations = Object.entries(document.paths ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, value]) => {
      const item = record(value);
      return ["get", "post", "put", "patch", "delete", "head", "options", "trace"]
        .filter((method) => item[method])
        .map((method) => ({
          path,
          method: method.toUpperCase(),
          operation: record(item[method]),
          parameters: item.parameters,
        }));
    });
  const title = document.info?.title ?? "Toolstack API";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:1000px;margin:auto;padding:32px 24px}a{color:LinkText}h1,h2{line-height:1.2}header{margin-bottom:40px}nav{display:flex;gap:24px;flex-wrap:wrap}table{width:100%;border-collapse:collapse;margin-bottom:40px}th,td{text-align:left;padding:10px;border-bottom:1px solid GrayText}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:color-mix(in srgb,CanvasText 6%,Canvas);border-radius:6px}summary{cursor:pointer;padding:12px 0}details{border-bottom:1px solid GrayText}small{color:GrayText}section{margin:32px 0}caption{text-align:left;font-weight:600}a:focus-visible,summary:focus-visible{outline:2px solid LinkText;outline-offset:3px}@media(max-width:600px){body{padding:20px 12px}th,td{padding:6px}code{overflow-wrap:anywhere}}
</style></head><body><header><h1>${escape(title)}</h1>
<p>${escape(document.info?.description)}</p><small>Version ${escape(document.info?.version)} · ${operations.length} operations</small>
<nav aria-label="Reference"><a href="/documentation/openapi.json">OpenAPI JSON</a><a href="/documentation/openapi.yaml">OpenAPI YAML</a><a href="#schemas">Schemas</a></nav></header>
<table><caption>Endpoints</caption><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody>
${operations.map(({ path, method, operation }, index) => `<tr><td><code>${method}</code></td><td><a href="#operation-${index}"><code>${escape(path)}</code></a></td><td>${escape(operation.summary ?? operation.operationId)}</td></tr>`).join("\n")}
</tbody></table><section aria-labelledby="operations"><h2 id="operations">Operations</h2>
${operations.map(({ path, method, operation, parameters }, index) => `<details id="operation-${index}"><summary><code>${method} ${escape(path)}</code> ${escape(operation.summary)}</summary>${operation.description ? `<p>${escape(operation.description)}</p>` : ""}${json({ ...(parameters ? { pathParameters: parameters } : {}), ...operation })}</details>`).join("\n")}
</section><section aria-labelledby="schemas"><h2 id="schemas">Schemas</h2>${json(document.components ?? document.definitions ?? {})}</section></body></html>`;
}
