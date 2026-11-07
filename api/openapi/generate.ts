import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import browserSchemas from "../src/modules/sessions/sessions.schema.js";
import { buildJsonSchemas } from "../src/utils/schema.js";

// Export only the models consumed by ui/src/api.ts.
// The running service publishes its route documentation at /documentation.
const { CreateSession, SessionDetails, MultipleSessions, ReleaseSession } = browserSchemas;
const { schemas } = buildJsonSchemas({
  CreateSession,
  SessionDetails,
  MultipleSessions,
  ReleaseSession,
});
const document = {
  openapi: "3.0.3",
  info: { title: "Toolstack models", version: "0.5.3" },
  paths: {},
  components: {
    schemas: Object.fromEntries(schemas.map(({ $id, ...schema }) => [$id, schema])),
  },
};
const output = fileURLToPath(new URL("./schemas.json", import.meta.url));
writeFileSync(output, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${schemas.length} API models to ${output}`);
