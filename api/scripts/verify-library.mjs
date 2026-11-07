import { organizationMember } from "../build/services/organization.js";
// Real browser and Postgres verification in an isolated schema. Object bytes use
// an in-process fixture here; Wasabi is checked separately against its own bucket.
// No production profiles, provider generation, or teammate provisioning is used.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import puppeteer from "puppeteer-core";
import Fastify from "fastify";
import net from "node:net";
import http from "node:http";

const root = await mkdtemp(path.join(tmpdir(), "toolstack-library-ui-"));
const key = randomBytes(32).toString("hex"),
  schema = `toolstack_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const url = process.env.TOOLSTACK_TEST_DATABASE_URL;
if (!url) throw new Error("Run npm run verify:library -w api");
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
Object.assign(process.env, {
  NODE_ENV: "test",
  STEEL_ROLE: "standalone",
  STEEL_USER_ID: "alice",
  STEEL_API_KEY: key,
  STEEL_AGENT_KEYS: "[]",
  DOMAIN: `127.0.0.1:${port}`,
  USE_SSL: "false",
  VAULT_KEY: randomBytes(32).toString("hex"),
  VAULT_PATH: path.join(root, "vault"),
  PROFILES_ROOT: path.join(root, "profiles"),
  FILES_ROOT: path.join(root, "files"),
  ENABLE_COMMANDS_API: "true",
  CHROME_HEADLESS: "true",
  CHROME_EXECUTABLE_PATH:
    process.env.CHROME_EXECUTABLE_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
delete process.env.STEEL_SHARED_URL;
delete process.env.STEEL_SHARED_KEY;
delete process.env.TOOLSTACK_DATABASE_URL;
const admin = postgres(url, { max: 1, onnotice: () => {} });
let app, browser, gateway, library, sql;
const workers = [];
const objects = new Map();
const output = process.env.TOOLSTACK_QA_OUTPUT;
try {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  sql = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: schema } });
  const [
    { ContentLibrary },
    { default: plugin },
    { default: ui },
    auth,
    { GatewayStore },
    { createGateway },
  ] = await Promise.all([
    import("../build/services/library/library.js"),
    import("../build/toolstack-plugin.js"),
    import("../build/plugins/ui-plugin.js"),
    import("../build/utils/api-key.js"),
    import("../build/gateway/store.js"),
    import("../build/gateway/server.js"),
  ]);
  library = new ContentLibrary(sql, {
    put: async (k, b) => objects.set(k, Buffer.from(b)),
    get: async (k) => objects.get(k),
    remove: async (k) => objects.delete(k),
    close: () => {},
  });
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    if (!auth.isAuthorized(req.raw)) return reply.code(401).send({ error: "Unauthorized" });
  });
  await app.register(plugin, { contentLibrary: library });
  await app.register(ui, {
    uiDistPath: fileURLToPath(new URL("../../ui/dist", import.meta.url)),
    uiPrefix: "/ui/",
  });
  await app.listen({ host: "127.0.0.1", port });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  process.env.DOMAIN = origin.replace("http://", "");
  process.env.USE_SSL = "false";
  const store = new GatewayStore(
    path.join(root, "gateway.enc"),
    randomBytes(32).toString("hex"),
    randomBytes(32).toString("hex"),
  );
  await store.ready;
  const accounts = {};
  for (const id of ["alice", "bob", "carol"]) {
    const worker = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
    workers.push(worker);
    const sharedKey = randomBytes(32).toString("hex");
    const result = await store.register({
      id,
      name: id,
      backendUrl: `http://127.0.0.1:${worker.address().port}`,
      backendKey: randomBytes(32).toString("hex"),
      sharedKey,
    });
    accounts[id] = { ...(await store.claim(result.invitation)), sharedKey };
  }
  gateway = createGateway(store, "http://127.0.0.1", true, library);
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const central = `http://127.0.0.1:${gateway.address().port}`;
  const foreignClaim = { ...store.authenticate(accounts.alice.key), expires: Date.now() + 300000 };
  const forged = await fetch(`${central}/internal/library`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accounts.bob.sharedKey}`,
      "x-toolstack-org-id": store.organization.id,
      "content-type": "application/json",
    },
    body: JSON.stringify({ principal: foreignClaim, command: { action: "list" } }),
  });
  assert.equal(forged.status, 401);
  const personRead = (id, resource) =>
    fetch(`${central}/v1/library/${resource}`, {
      headers: { authorization: `Bearer ${accounts[id].key}` },
    });
  browser = await puppeteer.launch({
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: true,
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setCookie({
    name: "steel_api_key",
    value: key,
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  });
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(`${origin}/ui/#/library`, { waitUntil: "networkidle0" });
  const click = async (label, scope = "body") => {
    await page.evaluate(
      (text, selector) => {
        const button = [...document.querySelectorAll(`${selector} button`)].find(
          (item) => item.textContent.trim() === text,
        );
        if (!button) throw new Error(`Missing button ${text}`);
        button.click();
      },
      label,
      scope,
    );
  };
  const notice = (label) =>
    page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('[role="status"]')].some((item) =>
          item.textContent.includes(text),
        ),
      {},
      label,
    );
  await page.waitForFunction(() =>
    document.querySelector(".result-count")?.textContent.includes("0 packages"),
  );
  await click("New package");
  await page.type('[name="title"]', "Print preparation method");
  const instructionsFile = path.join(root, "SKILL.md");
  await writeFile(instructionsFile, "Validate the design. Keep API keys in Connections.");
  await (await page.$('input[type="file"][accept]')).uploadFile(instructionsFile);
  await page.waitForFunction(() =>
    document.querySelector('[name="instructions"]')?.value.startsWith("Validate the design."),
  );
  await click("Save package");
  await notice("Saved");
  const [stored] = await sql`SELECT id FROM toolstack_packages WHERE owner_id='alice'`;
  assert.ok(stored?.id);
  assert.equal((await personRead("bob", stored.id)).status, 404);
  const file = path.join(root, "café 'check'.py");
  await writeFile(file, "print('fixture')\n");
  await page.select(".library-upload select", "script");
  await (await page.$('.library-upload input[type="file"]')).uploadFile(file);
  await notice("File stored and verified");
  const row = await library.call(organizationMember("alice"), { action: "get", id: stored.id });
  const asset = row.files[0];
  assert.equal(asset.name, "café 'check'.py");
  const digest = createHash("sha256").update("print('fixture')\n").digest("hex");
  assert.equal(asset.sha256, digest);
  const ownerFile = await personRead("alice", `${stored.id}/files/${asset.id}`);
  assert.equal(await ownerFile.text(), "print('fixture')\n");
  assert.equal(ownerFile.headers.get("x-content-sha256"), digest);
  const chooseVisibility = async (value) =>
    page.evaluate((next) => {
      const field = [...document.querySelectorAll("select")].find((item) =>
        [...item.options].some((option) => option.value === "global"),
      );
      field.value = next;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  await chooseVisibility("global");
  await click("Apply sharing");
  await page.waitForSelector("dialog[open]");
  await click("Apply sharing", "dialog");
  await notice("Sharing updated");
  assert.equal((await personRead("bob", stored.id)).status, 200);
  await chooseVisibility("assigned");
  await page.type('input[placeholder="Separate user IDs with commas"]', "bob");
  await click("Apply sharing");
  await page.waitForSelector("dialog[open]");
  await click("Apply sharing", "dialog");
  await notice("Sharing updated");
  assert.equal((await personRead("bob", stored.id)).status, 200);
  assert.equal((await personRead("carol", stored.id)).status, 404);
  await chooseVisibility("private");
  await click("Apply sharing");
  await page.waitForSelector("dialog[open]");
  await click("Apply sharing", "dialog");
  await notice("Sharing updated");
  assert.equal((await personRead("bob", `${stored.id}/files/${asset.id}`)).status, 404);
  await page.type('[name="instructions"]', " Unsaved edit.");
  await page.evaluate(() => {
    window.location.hash = "/toolkits";
  });
  await page.waitForSelector("dialog[open]");
  await click("Keep editing", "dialog");
  assert.ok(page.url().endsWith("#/library"));
  await page.evaluate(() => {
    window.location.hash = "/toolkits";
  });
  await page.waitForSelector("dialog[open]");
  await click("Discard changes", "dialog");
  await page.waitForSelector(".tool-item");
  await page.evaluate(() => {
    window.location.hash = "/library";
  });
  await page.waitForSelector(".library-package");
  await page.click(".library-package");
  await page.waitForSelector(".library-instructions");
  assert.equal(
    await page.$eval(".library-instructions", (item) => item.value),
    "Validate the design. Keep API keys in Connections.",
  );
  await click("Show versions");
  await page.waitForSelector(".library-history");
  await click("Version 1");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (item) => item.textContent.trim() === "Restore this version",
    ),
  );
  await click("Restore this version");
  await notice("Version restored");
  await click("Archive");
  await page.waitForSelector("dialog[open]");
  await click("Archive", "dialog");
  await notice("Package archived");
  await click("Restore package");
  await page.waitForSelector("dialog[open]");
  await click("Restore", "dialog");
  await notice("Package restored");
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(
      await page.$eval(".library-editor", (item) => item.scrollWidth <= item.clientWidth + 1),
    );
    if (output)
      await page.screenshot({ path: path.join(output, `library-${width}.png`), fullPage: true });
  }
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  if (output)
    await page.screenshot({ path: path.join(output, "library-dark.png"), fullPage: true });
  assert.deepEqual(errors, []);
  const count = await sql`SELECT count(*)::integer AS count FROM toolstack_package_versions`;
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "UI-create-save",
          "private-default",
          "Unicode-file-upload",
          "authenticated-download-checksum",
          "global-publication",
          "assignment",
          "revocation",
          "unsaved-navigation-guard",
          "immutable-history-restore",
          "archive-restore",
          "mobile-overflow",
          "light-dark",
          "no-browser-errors",
        ],
        database: "real temporary Postgres",
        objectStorage: "fixture",
        packageVersions: count[0].count,
        screenshots: output ?? "not requested",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
  await Promise.all(workers.map((worker) => new Promise((resolve) => worker.close(resolve))));
  await app?.close();
  if (sql) await sql.end({ timeout: 2 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end({ timeout: 2 });
  await rm(root, { recursive: true, force: true });
}
