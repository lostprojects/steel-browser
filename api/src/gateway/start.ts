import "../load-env.js";
import { startGateway } from "./server.js";

if (process.env.STEEL_ROLE && process.env.STEEL_ROLE !== "gateway")
  throw new Error("The gateway image requires STEEL_ROLE=gateway");
await startGateway();
