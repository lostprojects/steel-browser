import { scrubObject } from "./services/vault.js";
import { FastifyServerOptions } from "fastify";

interface LoggingConfig {
  [key: string]: FastifyServerOptions["logger"];
}

export const loggingConfig: LoggingConfig = {
  development: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
    level: process.env.LOG_LEVEL || "debug",
  },
  production: {},
  test: false,
};

// Pino hooks cover structured messages and errors before serializers or transports.
for (const config of Object.values(loggingConfig)) {
  if (config && typeof config === "object")
    config.hooks = {
      logMethod(args, method) {
        return method.apply(this, args.map(scrubObject) as any);
      },
    };
}
