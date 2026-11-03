import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemas } from "../src/plugins/schemas.js";

// Export shared models for the UI without starting the API or browser services.
// The running service publishes its route documentation at /documentation.
const document = {
  openapi: "3.0.3",
  info: { title: "Mosaic Steel Browser models", version: "0.5.3" },
  paths: {},
  components: {
    schemas: Object.fromEntries(schemas.map(({ $id, ...schema }) => [$id, schema])),
  },
};
const output = fileURLToPath(new URL("./schemas.json", import.meta.url));
writeFileSync(output, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${schemas.length} API models to ${output}`);
