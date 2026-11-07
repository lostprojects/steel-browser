// Provision one gateway and dedicated user workers. Secrets are written only to
// private operator-selected files; this command must not print or share them.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
const secret = () => randomBytes(32).toString("base64url");
const hex = () => randomBytes(32).toString("hex");
function required(value: string | undefined, usage: string): string {
  if (!value) throw new Error(usage);
  return value;
}
function origin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use a canonical HTTPS origin");
  return url.origin;
}
async function save(file: string, value: string) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { flag: "wx", mode: 0o600 });
  console.info(`Wrote private configuration: ${path.resolve(file)}`);
}
async function api(method: string, endpoint: string, body?: unknown) {
  const base = origin(required(process.env.STEEL_URL, "Set STEEL_URL to the gateway origin"));
  const key = required(process.env.STEEL_API_KEY, "Set STEEL_API_KEY to the gateway owner key");
  const response = await fetch(base + endpoint, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as any;
  if (!response.ok)
    throw new Error(`Team operation failed (${response.status}): ${result.error ?? "unavailable"}`);
  return result;
}
async function main() {
  const organizationId = process.env.TOOLSTACK_ORG_ID;
  if (["init", "worker"].includes(command)) {
    if (
      !organizationId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        organizationId,
      )
    )
      throw new Error("Set TOOLSTACK_ORG_ID to the existing organization's ID before provisioning");
  }
  if (command === "init") {
    const base = origin(required(args[0], "init HTTPS_ORIGIN OUTPUT_DIRECTORY"));
    const directory = required(args[1], "init HTTPS_ORIGIN OUTPUT_DIRECTORY");
    await save(
      path.join(directory, "gateway.env"),
      [
        "STEEL_ROLE=gateway",
        `TOOLSTACK_ORG_ID=${organizationId}`,
        `TOOLSTACK_ORG_NAME=${JSON.stringify(process.env.TOOLSTACK_ORG_NAME ?? "My organization")}`,
        "NODE_ENV=production",
        "HOST=::",
        "PORT=3000",
        `STEEL_PUBLIC_ORIGIN=${base}`,
        `STEEL_API_KEY=${secret()}`,
        `GATEWAY_STORE_KEY=${hex()}`,
        "GATEWAY_STORE_PATH=/data/gateway.enc",
        "",
      ].join("\n"),
    );
    console.info("Prepared 1 gateway configuration. Deploy it with its own empty /data volume.");
  } else if (command === "worker") {
    if (args.length > 5 || (args[4] !== undefined && args[4] !== "--migrate-owner"))
      throw new Error(
        "Unknown worker option; use --migrate-owner only for the existing owner volume",
      );
    const id = required(args[0], "worker USER_ID GATEWAY_ORIGIN WORKER_ORIGIN OUTPUT_DIRECTORY");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid user ID");
    const base = origin(required(args[1], "Missing gateway origin"));
    const backend = new URL(required(args[2], "Missing worker origin"));
    if (
      backend.username ||
      backend.password ||
      backend.pathname !== "/" ||
      backend.search ||
      backend.hash ||
      !(
        backend.protocol === "https:" ||
        (backend.protocol === "http:" && backend.hostname.endsWith(".railway.internal"))
      )
    )
      throw new Error("Use an HTTPS or Railway private worker origin");
    const directory = required(args[3], "Missing private output directory");
    const migrate = args[4] === "--migrate-owner";
    if (migrate && id !== "owner") throw new Error("Only the owner can use the existing volume");
    const vaultKey = migrate
      ? required(
          process.env.STEEL_EXISTING_VAULT_KEY,
          "Provide the existing owner's VAULT_KEY as STEEL_EXISTING_VAULT_KEY",
        )
      : hex();
    const backendKey = migrate
      ? required(
          process.env.STEEL_EXISTING_WORKER_KEY,
          "Provide the existing owner's API key as STEEL_EXISTING_WORKER_KEY",
        )
      : secret();
    if (!/^[a-fA-F0-9]{64}$/.test(vaultKey) || backendKey.length < 32)
      throw new Error("Invalid existing worker secrets");
    const maxSessions = migrate
      ? Number(
          required(
            process.env.STEEL_EXISTING_MAX_SESSIONS,
            "Provide the owner's actual configured capacity as STEEL_EXISTING_MAX_SESSIONS",
          ),
        )
      : 3;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
      throw new Error("Invalid worker capacity; use the existing positive integer capacity");
    const sharedKey = secret();
    await save(
      path.join(directory, `${id}.worker.env`),
      [
        "STEEL_ROLE=worker",
        `TOOLSTACK_ORG_ID=${organizationId}`,
        `TOOLSTACK_ORG_NAME=${JSON.stringify(process.env.TOOLSTACK_ORG_NAME ?? "My organization")}`,
        `STEEL_USER_ID=${id}`,
        "NODE_ENV=production",
        "HOST=::",
        "PORT=3000",
        `DOMAIN=${new URL(base).host}`,
        "USE_SSL=true",
        `STEEL_API_KEY=${backendKey}`,
        `VAULT_KEY=${vaultKey}`,
        `STEEL_SHARED_URL=${base}`,
        `STEEL_SHARED_KEY=${sharedKey}`,
        "PROFILES_ROOT=/data/profiles",
        "VAULT_PATH=/data/vault",
        "CHROME_HEADLESS=false",
        "ENABLE_COMMANDS_API=true",
        "CAPTURE_CONSOLE_EVENTS=false",
        "ENABLE_PDF_VIEWER=true",
        `MAX_SESSIONS=${maxSessions}`,
        "",
      ].join("\n"),
    );
    await save(
      path.join(directory, `${id}.register.json`),
      JSON.stringify({ id, name: id, backendUrl: backend.origin, backendKey, sharedKey }, null, 2) +
        "\n",
    );
    console.info(
      `Prepared 2 worker files for ${id}. ${migrate ? "Keep the existing owner volume, proxy settings and named keys." : "Deploy with a new private volume and service-owned proxy settings."}`,
    );
  } else if (command === "register") {
    const input = JSON.parse(
      await readFile(required(args[0], "register REGISTRATION_FILE INVITATION_FILE"), "utf8"),
    );
    const output = required(args[1], "Supply a private invitation output path");
    // Reserve the output before consuming a one-time invitation response.
    await save(output, "");
    const result = await api("POST", "/v1/team/users", input);
    await writeFile(
      output,
      result.inviteUrl
        ? result.inviteUrl + "\n"
        : "Owner worker registered. Sign in with the gateway owner key.\n",
      { mode: 0o600 },
    );
    console.info(
      `Registered ${result.id}; saved 1 private onboarding result to ${path.resolve(output)}`,
    );
  } else if (command === "invite") {
    const id = encodeURIComponent(required(args[0], "invite USER_ID OUTPUT_FILE"));
    const output = required(args[1], "Supply a private invitation output path");
    await save(output, "");
    const result = await api("POST", `/v1/team/users/${id}/invite`, {});
    await writeFile(output, result.inviteUrl + "\n", { mode: 0o600 });
    console.info(`Saved 1 replacement invitation to ${path.resolve(output)}`);
  } else if (command === "users") {
    const users = await api("GET", "/v1/team/users");
    console.table(users);
    console.info(`${users.length} users; no browsing data requested.`);
  } else if (command === "disable" || command === "enable") {
    const id = encodeURIComponent(required(args[0], `${command} USER_ID`));
    const result = await api("POST", `/v1/team/users/${id}/access`, {
      disabled: command === "disable",
    });
    console.info(`${result.id}: access ${result.disabled ? "disabled" : "enabled"}`);
  } else if (command === "shared-grants") {
    const name = encodeURIComponent(required(args[0], "shared-grants NAME USER_ID [USER_ID…]"));
    const allowedUsers = args.slice(1);
    if (
      !allowedUsers.length ||
      allowedUsers.length > 100 ||
      allowedUsers.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
    )
      throw new Error("Supply one to one hundred registered user IDs");
    const result = await api("PUT", `/v1/global/vault/${name}/grants`, { allowedUsers });
    console.info(
      `Updated 1 shared account grant: ${result.name}, ${result.allowedUsers.length} users`,
    );
  } else if (command === "shared-vault" || command === "shared-site") {
    const name = encodeURIComponent(required(args[0], `${command} NAME JSON_FILE`));
    const input = JSON.parse(
      await readFile(required(args[1], "Supply the JSON input file"), "utf8"),
    );
    const result = await api(
      "PUT",
      `/v1/global/${command === "shared-vault" ? "vault" : "sites"}/${name}`,
      input,
    );
    console.info(`Updated 1 shared entry: ${result.name}`);
  } else {
    console.info(
      "Toolstack team administration\n\ninit HTTPS_ORIGIN OUTPUT_DIRECTORY\nworker USER_ID GATEWAY_ORIGIN WORKER_ORIGIN OUTPUT_DIRECTORY [--migrate-owner]\nregister REGISTRATION_FILE INVITATION_FILE\ninvite USER_ID INVITATION_FILE\nusers\ndisable USER_ID\nenable USER_ID\nshared-vault NAME FIELDS_JSON_FILE\nshared-site HOST SITE_JSON_FILE\nshared-grants NAME USER_ID [USER_ID…]\n\nRemote operations read STEEL_URL and STEEL_API_KEY from the environment. See TEAM.md.",
    );
  }
}
await main();
