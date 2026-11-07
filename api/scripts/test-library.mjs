// Starts a temporary, password-protected Postgres cluster for library checks.
// No installed service is started and no production database URL is accepted.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import postgres from "postgres";
import { existsSync } from "node:fs";

const scratch = path.resolve("../.tmp");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(path.join(scratch, "toolstack-pg-"));
const bin =
  process.env.TOOLSTACK_POSTGRES_BIN ??
  [
    "/Applications/Postgres.app/Contents/Versions/18/bin",
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/lib/postgresql/18/bin",
  ].find((value) => existsSync(path.join(value, "initdb")));
const password = randomBytes(24).toString("hex");
let server, log, pool;
const child = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const process = spawn(file, args, { stdio: "inherit", ...options });
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)),
    );
  });
try {
  if (!bin) throw new Error("Set TOOLSTACK_POSTGRES_BIN to an installed Postgres bin directory");
  await writeFile(path.join(root, "password"), password, { mode: 0o600 });
  await mkdir(path.join(root, "socket"));
  await child(
    path.join(bin, "initdb"),
    [
      "-D",
      path.join(root, "data"),
      "-U",
      "toolstack_test",
      "--pwfile",
      path.join(root, "password"),
      "--auth=scram-sha-256",
      "--no-locale",
      "-E",
      "UTF8",
    ],
    { stdio: "ignore" },
  );
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  log = await open(path.join(root, "postgres.log"), "w");
  server = spawn(
    path.join(bin, "postgres"),
    [
      "-D",
      path.join(root, "data"),
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-k",
      path.join(root, "socket"),
      "-c",
      "shared_buffers=16MB",
      "-c",
      "max_connections=30",
    ],
    { stdio: ["ignore", log.fd, log.fd] },
  );
  let startupError;
  server.once("error", (error) => {
    startupError = error;
  });
  const url = `postgres://toolstack_test:${password}@127.0.0.1:${port}/postgres`;
  pool = postgres(url, { connect_timeout: 1, max: 1 });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try {
      await pool`SELECT 1`;
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!ready) throw new Error("Temporary Postgres did not become ready");
  await pool.end({ timeout: 2 });
  pool = undefined;
  await child(
    process.execPath,
    process.argv.includes("--ui")
      ? ["scripts/verify-library.mjs"]
      : [
          "../node_modules/vitest/vitest.mjs",
          "run",
          process.argv.includes("--jobs")
            ? "src/services/jobs/jobs.test.ts"
            : "src/services/library/library.test.ts",
        ],
    {
      env: {
        ...process.env,
        ...(process.platform === "linux" ? { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } : {}),
        TOOLSTACK_TEST_DATABASE_URL: url,
      },
    },
  );
  console.log(
    JSON.stringify({
      passed: true,
      database: "temporary Postgres",
      clusterPath: root,
      removedOnExit: true,
    }),
  );
} finally {
  await pool?.end({ timeout: 2 });
  if (server && server.exitCode === null) {
    const done = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGINT");
    await done;
  }
  await log?.close();
  await rm(root, { recursive: true, force: true });
}
