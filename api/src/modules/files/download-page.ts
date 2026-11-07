import type { FastifyInstance } from "fastify";
import { selectedTransfers } from "../sessions/sessions.controller.js";
import { z } from "zod";

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Toolstack download</title>
<style>:root{font:16px/1.6 system-ui,sans-serif;color:#e9e9e6;background:#151715}*{box-sizing:border-box}body{margin:0}main{max-width:620px;margin:12vh auto;padding:32px}.brand{font:12px monospace;letter-spacing:.13em;color:#aac5a5}h1{font-size:32px;line-height:1.2;overflow-wrap:anywhere;margin:28px 0 18px}p{color:#b9beb7}a{color:#c4dfb7}#save,button{display:inline-block;border:0;border-radius:6px;background:#c4dfb7;color:#152010;padding:12px 20px;text-decoration:none;font:inherit;cursor:pointer}button{background:none;color:#b9beb7;padding:8px 0;font-size:14px}footer{border-top:1px solid #394137;margin-top:36px;padding-top:20px}[hidden]{display:none!important}</style></head>
<body><main><span class="brand">TOOLSTACK / DOWNLOAD</span><h1 id="name">Preparing your file…</h1><p id="status" role="status">Checking the download.</p><a id="save" hidden>Download</a><p id="expiry"></p><button id="remove" hidden>Remove from Toolstack</button><footer><a href="/ui/">Open Toolstack</a></footer></main><script src="/downloads/app.js" defer></script></body></html>`;

const script = `const byId = id => document.getElementById(id);
const [session, transfer] = location.pathname.split('/').slice(2);
const endpoint = '/v1/sessions/' + session + '/transfers/' + transfer;
let stopped = false;
async function refresh() {
 try {
  const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 410 ? 'This download has expired. Ask your agent to prepare it again.' : 'Sign in to Toolstack to open this download.');
  const file = await response.json();
  byId('name').textContent = file.name;
  if (file.state === 'receiving') { byId('status').textContent = 'Your file is still being prepared.'; if (!stopped) setTimeout(refresh, 1000); return; }
  if (file.state !== 'ready') throw new Error(file.state === 'acknowledged' ? 'This file has already been collected.' : 'This download is no longer available.');
  if (new Date(file.expiresAt).getTime() <= Date.now()) throw new Error('This download has expired. Ask your agent to prepare it again.');
  const target = new URL(file.uri, location.origin);
  if (target.origin !== location.origin) throw new Error('This download is unavailable.');
  byId('status').textContent = 'Ready to save · ' + new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(file.bytes) + ' bytes';
  byId('save').href = target.href; byId('save').download = file.name; byId('save').hidden = false;
  byId('expiry').textContent = 'Available until ' + new Date(file.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. Toolstack removes its copy automatically.';
  byId('remove').hidden = false;
 } catch (error) { byId('status').textContent = error.message; byId('save').hidden = true; }
}
byId('remove').onclick = async () => {
 try { const response = await fetch(endpoint, { method: 'DELETE', credentials: 'same-origin' }); if (!response.ok) throw new Error('Could not remove this file.'); byId('save').hidden = byId('remove').hidden = true; byId('status').textContent = 'Removed from Toolstack.'; byId('expiry').textContent = ''; }
 catch (error) { byId('status').textContent = error.message; }
};
addEventListener('pagehide', () => { stopped = true; }); refresh();`;

export default async function downloadPages(server: FastifyInstance) {
  server.get("/downloads/app.js", { schema: { hide: true } }, (_request, reply) =>
    reply.header("cache-control", "no-store").type("text/javascript").send(script),
  );
  server.get("/downloads/:sessionId/:transferId", { schema: { hide: true } }, (request, reply) => {
    const params = z
      .object({ sessionId: z.string().uuid(), transferId: z.string().uuid() })
      .parse(request.params);
    selectedTransfers(server, request).status(params.transferId);
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      )
      .type("text/html; charset=utf-8")
      .send(page);
  });
}
