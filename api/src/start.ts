import "./load-env.js";
if (process.env.STEEL_ROLE === "gateway") {
  const { startGateway } = await import("./gateway/server.js");
  await startGateway();
} else {
  if (process.env.STEEL_ROLE && !["worker", "standalone"].includes(process.env.STEEL_ROLE))
    throw new Error("Invalid STEEL_ROLE");
  await import("./index.js");
}
