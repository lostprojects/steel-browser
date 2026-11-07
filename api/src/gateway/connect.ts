export const connectPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Toolstack</title><link rel="stylesheet" href="/connect.css"></head>
<body><main><span class="brand">TOOLSTACK / YOUR WORKSPACE</span><h1>Connect your tools.</h1>
<p>Add Toolstack to your agent and approve the connection in your browser. No software to install.</p>
<section class="address"><label for="server">Connection address</label><input id="server" readonly><button id="copy-server" type="button">Copy address</button><p>Use this address in your agent’s remote MCP connections.</p></section>
<form id="login"><label for="key">Sign in with your access key</label><input id="key" type="password" autocomplete="current-password" required maxlength="512"><button>Sign in</button></form>
<button id="accept" type="button" hidden>Accept invitation</button>
<p id="status" role="status"></p>
<section id="authorization" hidden><h2>Allow this connection?</h2><p><strong id="client-name"></strong> wants to use the tools and accounts available to you, including your private browser and downloaded files. Tool and account permissions apply.</p><p>The connection returns to <code id="callback"></code>.</p><p id="local-callback" hidden>Confirm that you started this connection in an app on this computer.</p><button id="allow" type="button">Allow connection</button><button id="deny" type="button" class="secondary">Cancel</button></section>
<section id="issued" hidden><h2>Save this access key</h2><p>This key is shown once. Keep it in your password manager so you can sign in again. Agent apps can connect through browser approval.</p><textarea id="new-key" readonly rows="2" aria-label="New access key"></textarea><button id="copy" type="button">Copy key</button></section>
<section id="account" hidden><h2>Your connections</h2><p id="user"></p><ul id="connections"></ul><p id="no-connections" hidden>Add the connection address to your agent to get started.</p>
<details><summary>Advanced key access</summary><form id="create"><label for="label">Name a new key</label><input id="label" required maxlength="80" placeholder="Automation"><button>Create key</button></form><ul id="keys"></ul></details>
<p><a href="/ui/">Open Toolstack</a> · <button id="logout" class="link" type="button">Sign out</button></p></section>
<footer>Your Toolstack history and browser sessions stay private to you, including when you use a shared login. The global store shares credentials and defaults only.</footer>
</main><script src="/connect.js" defer></script></body></html>`;

export const connectStyle = `:root{font:16px/1.6 system-ui,sans-serif;color:#e9e9e6;background:#151715}*{box-sizing:border-box}body{margin:0}main{max-width:650px;margin:8vh auto;padding:32px}.brand{font:12px monospace;letter-spacing:.13em;color:#aac5a5}h1{font-size:38px;line-height:1.15;letter-spacing:-.03em;margin:28px 0 20px}h2{font-size:22px}p,footer{color:#b9beb7}label{display:block;margin:22px 0 8px}input,textarea{width:100%;background:#222722;border:1px solid #465046;border-radius:6px;color:inherit;padding:12px;font:inherit}textarea{font:13px monospace}button{cursor:pointer;padding:10px 18px;margin:12px 8px 0 0;border:0;border-radius:6px;background:#c4dfb7;color:#152010;font:inherit}a{color:#c4dfb7}.link{padding:0;background:none;color:#c4dfb7}section{border-top:1px solid #394137;margin-top:32px;padding-top:12px}li{margin:12px 0}li button{font-size:13px;margin-left:12px;padding:4px 8px}footer{border-top:1px solid #394137;margin-top:48px;padding-top:20px;font-size:13px}#status{color:#d8dfc4;overflow-wrap:anywhere}[hidden]{display:none!important}`;

export const connectScript = `
const byId = (id) => document.getElementById(id);
const status = (message) => { byId('status').textContent = message; };
async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
function showKey(key) {
  byId('issued').hidden = false;
  byId('new-key').value = key;
}
const parameters = new URLSearchParams(location.search);
const authorization = parameters.get('request');
const next = parameters.get('next');
byId('server').value = location.origin + '/mcp';
byId('copy-server').onclick = async () => { try { await navigator.clipboard.writeText(byId('server').value); status('Address copied. Add it to your agent’s connections.'); } catch { byId('server').select(); status('Copy the selected address.'); } };
async function account() {
  const me = await api('/v1/me');
  byId('login').hidden = true;
  byId('account').hidden = false;
  byId('user').textContent = 'Connected as ' + me.userId;
  if (authorization) {
    const review = await api('/auth/authorization/' + encodeURIComponent(authorization));
    byId('authorization').hidden = false; byId('account').hidden = true;
    byId('client-name').textContent = review.client;
    byId('callback').textContent = review.callback;
    byId('local-callback').hidden = !review.local;
    for (const [id, allow] of [['allow', true], ['deny', false]]) byId(id).onclick = async () => {
      byId('allow').disabled = byId('deny').disabled = true;
      try { const result = await api('/auth/authorization/' + encodeURIComponent(authorization), 'POST', { csrf: review.csrf, allow }); location.replace(result.redirect); }
      catch (e) { status(e.message); byId('allow').disabled = byId('deny').disabled = false; }
    };
  } else if (next && (/^\\/downloads\\/[a-f0-9-]{36}\\/[a-f0-9-]{36}$/.test(next) || next === '/' || next.startsWith('/ui/'))) {
    location.replace(next); return;
  }
  const connections = await api('/v1/me/connections');
  byId('connections').replaceChildren(); byId('no-connections').hidden = connections.length > 0;
  for (const connection of connections) {
    const item = document.createElement('li'); item.textContent = connection.label;
    const disconnect = document.createElement('button'); disconnect.textContent = 'Disconnect';
    disconnect.onclick = async () => { try { await api('/v1/me/connections/' + connection.id, 'DELETE'); await account(); } catch (e) { status(e.message); } };
    item.append(disconnect); byId('connections').append(item);
  }
  const keys = await api('/v1/me/keys');
  byId('keys').replaceChildren();
  for (const key of keys) {
    const item = document.createElement('li');
    item.textContent = key.label;
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.onclick = async () => { try { await api('/v1/me/keys/' + key.id, 'DELETE'); await account(); } catch (e) { status(e.message); } };
    item.append(revoke); byId('keys').append(item);
  }
}
byId('login').onsubmit = async (event) => { event.preventDefault(); try {
  const key = byId('key').value; byId('key').value = '';
  await api('/auth/login', 'POST', { key }); await account(); status('Connected.');
} catch (e) { status(e.message); } };
byId('create').onsubmit = async (event) => { event.preventDefault(); try {
  const result = await api('/v1/me/keys', 'POST', { label: byId('label').value });
  byId('label').value = ''; showKey(result.key); await account(); status('Key created. Save it before leaving this page.');
} catch (e) { status(e.message); } };
byId('copy').onclick = async () => { try { await navigator.clipboard.writeText(byId('new-key').value); status('Key copied.'); } catch { status('Select and copy the key from the field above.'); } };
byId('logout').onclick = async () => { await api('/auth/logout', 'POST', {}); location.replace('/connect'); };
(async () => {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  history.replaceState(null, '', location.pathname + location.search);
  if (invite) {
    byId('login').hidden = true; byId('accept').hidden = false;
    status('Accept to activate your private browser and create an access key.');
    byId('accept').onclick = async () => {
      byId('accept').disabled = true;
      try { const result = await api('/auth/claim', 'POST', { invitation: invite }); byId('accept').hidden = true; showKey(result.key); await account(); status('Your private browser is ready. Save your access key.'); }
      catch (e) { status(e.message); byId('accept').disabled = false; }
    };
  } else { try { await account(); } catch { /* Show the sign-in form. */ } }
})();`;
