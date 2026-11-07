// Package the gateway and its installed runtime dependency closure. Keep
// browser code and service configuration out of this deployment artifact.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const role = process.argv.includes("--jobs") ? "jobs" : "gateway";
const output = path.resolve(root, `../build/${role}-runtime`);
const modules = path.resolve(root, "../node_modules");
const api = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "services"), { recursive: true });
if (role === "gateway")
  await cp(path.join(root, "build/gateway"), path.join(output, "gateway"), { recursive: true });
else
  await cp(path.join(root, "build/services/jobs"), path.join(output, "services/jobs"), {
    recursive: true,
  });
await cp(
  path.join(root, "build/services/shared-store.js"),
  path.join(output, "services/shared-store.js"),
);
await cp(path.join(root, "build/load-env.js"), path.join(output, "load-env.js"));
await cp(
  path.join(root, "build/services/organization.js"),
  path.join(output, "services/organization.js"),
);
await cp(
  path.join(root, "build/services/gateway-principal.js"),
  path.join(output, "services/gateway-principal.js"),
);
await cp(path.join(root, "build/services/library"), path.join(output, "services/library"), {
  recursive: true,
});
await mkdir(path.join(output, "utils"), { recursive: true });
for (const file of ["public-error.js", "content-disposition.js"])
  await cp(path.join(root, "build/utils", file), path.join(output, "utils", file));
const copied = new Set();
async function dependency(name, from) {
  let current = from;
  while (true) {
    const candidate = path.join(current, "node_modules", name, "package.json");
    try {
      return {
        directory: path.dirname(candidate),
        manifest: JSON.parse(await readFile(candidate, "utf8")),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Missing installed gateway dependency: ${name}`);
    current = parent;
  }
}
async function include(name, from) {
  const pkg = await dependency(name, from);
  if (copied.has(pkg.directory)) return pkg;
  const relative = path.relative(modules, pkg.directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Gateway dependency must be installed under the root node_modules: ${name}`);
  copied.add(pkg.directory);
  await cp(pkg.directory, path.join(output, "node_modules", relative), {
    recursive: true,
    filter: (file) => !path.relative(pkg.directory, file).split(path.sep).includes("node_modules"),
  });
  const requiredPeers = Object.keys(pkg.manifest.peerDependencies ?? {}).filter(
    (name) => !pkg.manifest.peerDependenciesMeta?.[name]?.optional,
  );
  for (const child of new Set([
    ...Object.keys(pkg.manifest.dependencies ?? {}),
    ...requiredPeers,
  ]))
    await include(child, pkg.directory);
  return pkg;
}
const dependencies = {};
for (const name of role === "gateway"
  ? ["zod", "express", "@modelcontextprotocol/sdk", "postgres", "@aws-sdk/client-s3"]
  : ["zod", "postgres", "pg-boss", "archiver", "@aws-sdk/client-s3"])
  dependencies[name] = (await include(name, root)).manifest.version;
await writeFile(
  path.join(output, "package.json"),
  JSON.stringify(
    {
      name: `@toolstack/${role}`,
      version: api.version,
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Packaged ${(await readdir(path.join(output, role === "gateway" ? "gateway" : "services/jobs"))).filter((name) => name.endsWith(".js")).length} ${role} modules and ${copied.size} installed runtime packages at ${output}`,
);
