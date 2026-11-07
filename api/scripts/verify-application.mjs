// Exercises the built application with an isolated worker, fixture credentials
// and real Chrome. Production profiles are excluded. An explicit Muse environment
// file enables one read-only live provider check using a temporary encrypted vault.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "toolstack-application-"));
const screenshots = process.env.TOOLSTACK_QA_OUTPUT;
const port = Number(process.env.TOOLSTACK_QA_PORT ?? 3198);
const origin = `http://127.0.0.1:${port}`;
const key = randomBytes(32).toString("hex");
Object.assign(process.env, {
  NODE_ENV: "test",
  DOMAIN: `127.0.0.1:${port}`,
  USE_SSL: "false",
  STEEL_ROLE: "standalone",
  STEEL_USER_ID: "owner",
  STEEL_API_KEY: key,
  STEEL_AGENT_KEYS: "[]",
  VAULT_KEY: randomBytes(32).toString("hex"),
  VAULT_PATH: path.join(root, "vault"),
  PROFILES_ROOT: path.join(root, "profiles"),
  FILES_ROOT: path.join(root, "files"),
  CHROME_HEADLESS: "true",
  ENABLE_COMMANDS_API: "true",
  CAPTURE_CONSOLE_EVENTS: "false",
  CHROME_EXECUTABLE_PATH:
    process.env.CHROME_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
delete process.env.STEEL_SHARED_URL;
delete process.env.STEEL_SHARED_KEY;
delete process.env.EVOMI_RESIDENTIAL_PROXY_URL;
let app, browser;
try {
  const [
    { default: fastify },
    { default: puppeteer },
    { z },
    { default: plugin },
    { default: ui },
    authentication,
    { vault },
    { browserApplication },
    { apiActionInput },
    { museContentToolkit },
  ] = await Promise.all([
    import("fastify"),
    import("puppeteer-core"),
    import("zod"),
    import("../build/toolstack-plugin.js"),
    import("../build/plugins/ui-plugin.js"),
    import("../build/utils/api-key.js"),
    import("../build/services/vault.js"),
    import("../build/services/browser-application.js"),
    import("../build/services/toolkits/api-input.js"),
    import("../build/content/muse-content.js"),
  ]);
  app = fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (!authentication.browserOriginAllowed(request.raw))
      return reply.code(403).send({ error: "Origin refused" });
    if (!authentication.isAuthorized(request.raw))
      return reply.code(401).send({ error: "Unauthorized" });
  });
  let dispatches = 0;
  await app.register(plugin, {
    apiToolkits: [
      museContentToolkit("owner"),
      {
        id: "fixture",
        name: "Workshop fixture",
        version: "1.0.0",
        description: "Acceptance-only arithmetic",
        authentication: "Isolated fixture account",
        credentialFields: ["apiKey"],
        actions: [
          {
            name: "fixture_sum",
            provider: "fixture",
            description: "Add two bounded numbers using a local fixture account.",
            annotations: { readOnlyHint: true, openWorldHint: false },
            input: apiActionInput.extend({
              a: z.number().min(0).max(100).default(2),
              b: z.number().min(0).max(100).default(3),
            }),
            reserveMicros: () => 0,
            run: async (args, credential) => {
              assert.equal(credential, "acceptance-fixture-secret");
              dispatches++;
              return {
                state: "succeeded",
                estimatedCostMicros: 0,
                data: {
                  sum: args.a + args.b,
                  sourceId: "fixture:arithmetic",
                  acquiredAt: new Date().toISOString(),
                },
              };
            },
          },
        ],
      },
    ],
  });
  await app.register(ui, { uiDistPath: path.join(repository, "ui/dist"), uiPrefix: "/ui/" });
  await app.listen({ host: "127.0.0.1", port });
  await vault.put(
    "fixture",
    { fields: { apiKey: "acceptance-fixture-secret" }, allowedAgents: ["admin"] },
    { name: "admin", admin: true, dailyBudgetBytes: 1000 },
  );
  const application = browserApplication(app.sessionPool);
  const admin = { name: "admin", admin: true, dailyBudgetBytes: 1000 };
  await application.connections.configure(
    "api:fixture",
    {
      label: "Workshop account",
      api: {
        provider: "fixture",
        vault: "fixture",
        allowedTools: ["fixture_sum"],
        dailyCalls: 5,
        dailyBudgetUSD: 0.01,
      },
    },
    admin,
  );
  await application.connections.configure(
    "browser:qa-profile",
    { label: "Saved QA profile" },
    admin,
  );
  let businessRead = false;
  if (process.env.TOOLSTACK_QA_MUSE_ENV_FILE) {
    const values = parseEnv(await readFile(process.env.TOOLSTACK_QA_MUSE_ENV_FILE, "utf8"));
    assert.ok(
      values.MUSE_ADMIN_API_TOKEN,
      "The selected environment file must contain the Muse API credential",
    );
    await vault.put(
      "muse-pilot",
      { fields: { apiKey: values.MUSE_ADMIN_API_TOKEN }, allowedAgents: ["admin"] },
      admin,
    );
    await application.connections.configure(
      "api:muse-pilot",
      {
        label: "Muse read pilot",
        api: { provider: "muse", vault: "muse-pilot", dailyCalls: 3, dailyBudgetUSD: 0.01 },
      },
      admin,
    );
    const response = await fetch(`${origin}/v1/tools/muse_document/execute`, {
      method: "POST",
      headers: { "steel-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        arguments: {
          connection: "api:muse-pilot",
          key: "business",
          idempotencyKey: "business-read",
        },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(!result.isError, "The live Muse content read must succeed");
    const content = JSON.parse(result.content[0].text);
    assert.equal(content.data.document.key, "business");
    assert.ok(content.data.document.version > 0);
    assert.match(content.data.sourceId, /^muse:business@\d+$/);
    assert.ok(Date.parse(content.data.acquiredAt));
    businessRead = true;
  }
  // A real Chrome profile must survive both closure and reopening.
  const profile = await application.open(
    { agent: admin },
    { identity: "qa-profile", headless: true },
  );
  const firstRead = await application.commands({ agent: admin }, profile.id, {
    commands: [{ command: "get", what: "url" }],
  });
  assert.equal(firstRead.status, 200);
  await application.release({ agent: admin }, profile.id);
  const preferences = path.join(root, "profiles/qa-profile/Default/Preferences");
  const saved = await readFile(preferences, "utf8");
  assert.ok(saved.length > 10);
  const reopened = await application.open(
    { agent: admin },
    { identity: "qa-profile", headless: true },
  );
  await application.release({ agent: admin }, reopened.id);
  assert.ok((await readFile(preferences, "utf8")).length > 10);
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1050, deviceScaleFactor: 1 });
  await page.setCookie({
    name: "steel_api_key",
    value: key,
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/ui/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".tool-item");
  assert.ok(
    (await page.$eval(".tool-list", (element) => element.textContent)).includes("Private content"),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".method-item")]
      .find((button) => button.textContent.includes("Review Muse website content"))
      .click(),
  );
  await page.waitForSelector(".workflow-instructions");
  assert.ok(
    (await page.$eval(".workflow-instructions", (element) => element.textContent)).includes(
      "version",
    ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".tool-item")]
      .find((button) => button.textContent.includes("fixture_sum"))
      .click(),
  );
  const connectionInput = await page.evaluate(
    () =>
      [...document.querySelectorAll(".field-label")].find((label) =>
        label.textContent.startsWith("connection"),
      ).htmlFor,
  );
  await page.select(`[id="${connectionInput}"]`, "api:fixture");
  await page.evaluate(() =>
    [...document.querySelectorAll(".tool-detail button")]
      .find((button) => button.textContent === "Edit JSON")
      .click(),
  );
  assert.equal(
    JSON.parse(await page.$eval(".tool-detail textarea", (element) => element.value)).connection,
    "api:fixture",
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".tool-detail button")]
      .find((button) => button.textContent === "Use fields")
      .click(),
  );
  const submit = async () => {
    const response = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === "/v1/tools/fixture_sum/execute",
    );
    await page.click(".tool-detail button[type=submit]");
    assert.equal((await response).status(), 200);
    await page.waitForSelector(".tool-result pre");
  };
  await submit();
  const result = JSON.parse(await page.$eval(".tool-result pre", (element) => element.textContent));
  assert.equal(result.data.sum, 5);
  assert.equal(dispatches, 1);
  await submit();
  assert.equal(dispatches, 1, "UI retry must reuse provider work");
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, "toolkits-desktop.png"), fullPage: true });
  }
  await page.goto(`${origin}/ui/#/connections`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".account-item");
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Add connection")
      .click(),
  );
  await page.waitForSelector("dialog[open]");
  await page.select("dialog[open] select", "browser");
  await page.type('dialog[open] input[name="name"]', "ui-created");
  await page.type('dialog[open] input[name="label"]', "UI created profile");
  await page.click('dialog[open] button[type="submit"]');
  await page.waitForSelector("dialog[open]", { hidden: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".account-item")].some((button) =>
      button.textContent.includes("UI created profile"),
    ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".account-item")]
      .find((button) => button.textContent.includes("UI created profile"))
      .click(),
  );
  const accountAction = async (label, next) => {
    await page.evaluate(
      (value) =>
        [...document.querySelectorAll(".connection-detail button")]
          .find((button) => button.textContent === value)
          .click(),
      label,
    );
    await page.waitForFunction(
      (value) =>
        [...document.querySelectorAll(".connection-detail button")].some(
          (button) => button.textContent === value,
        ),
      {},
      next,
    );
  };
  await accountAction("Disable account", "Enable account");
  await accountAction("Enable account", "Disable account");
  await accountAction("Disconnect…", "Disconnect account");
  await page.evaluate(() =>
    [...document.querySelectorAll(".connection-detail button")]
      .find((button) => button.textContent === "Disconnect account")
      .click(),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".connection-detail > .status-pill")?.textContent === "disconnected",
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".account-item")]
      .find((button) => button.textContent.includes("Workshop account"))
      .click(),
  );
  await page.waitForSelector(".usage-meters");
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, "connections-desktop.png"),
      fullPage: true,
    });
  await page.goto(`${origin}/ui/#/activity`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".activity-table");
  assert.ok(
    (await page.$eval(".activity-table", (element) => element.textContent)).includes("fixture_sum"),
  );
  for (const width of [390, 768, 1440]) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false, `Page overflow at ${width}px`);
    assert.equal(
      await page.$eval(".catalog-body", (element) => element.scrollWidth > element.clientWidth),
      false,
      `Content overflow at ${width}px`,
    );
    if (width <= 900)
      assert.ok(
        await page.$eval(".mobile-nav", (element) => element.getBoundingClientRect().height > 0),
      );
    if (width === 390) {
      await page.click('.mobile-nav a[href="#/toolkits"]');
      await page.waitForSelector(".tool-item");
      await page.click('.mobile-nav a[href="#/connections"]');
      await page.waitForSelector(".account-item");
      await page.click('.mobile-nav a[href="#/activity"]');
      await page.waitForSelector(".activity-table");
    }
    if (screenshots)
      await page.screenshot({
        path: path.join(screenshots, `activity-${width}.png`),
        fullPage: true,
      });
  }
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  if (screenshots)
    await page.screenshot({ path: path.join(screenshots, "activity-dark.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "real-profile-reopen",
          "UI-workflow-instructions",
          "UI-owned-content-scope",
          "UI-discovery",
          "UI-execution",
          "UI-retry-reuse",
          "UI-JSON-form-roundtrip",
          "UI-connection-create-disable-enable-disconnect",
          "account-allowance",
          "private-activity",
          "mobile-navigation",
          "no-page-overflow",
          "no-browser-errors",
          "light-and-dark-themes",
          ...(businessRead ? ["live-Muse-versioned-read"] : []),
        ],
        providerDispatches: dispatches,
        screenshots: screenshots ?? "not requested",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
