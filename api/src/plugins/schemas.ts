import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifySwagger from "@fastify/swagger";
import { renderApiReference } from "./api-reference.js";
import actionSchemas from "../modules/actions/actions.schema.js";
import cdpSchemas from "../modules/cdp/cdp.schemas.js";
import logsSchemas from "../modules/logs/logs.schema.js";
import browserSchemas from "../modules/sessions/sessions.schema.js";
import { buildJsonSchemas } from "../utils/schema.js";
import filesSchemas from "../modules/files/files.schema.js";
import commandsSchemas from "../modules/commands/commands.schema.js";
import { getBaseUrl } from "../utils/url.js";
import { env } from "../env.js";

const SCHEMAS = {
  ...actionSchemas,
  ...browserSchemas,
  ...logsSchemas,
  ...cdpSchemas,
  ...filesSchemas,
  ...commandsSchemas,
};

export const { schemas, $ref } = buildJsonSchemas(SCHEMAS);

const schemaPlugin: FastifyPluginAsync = async (fastify) => {
  for (const schema of schemas) {
    if (!env.ENABLE_COMMANDS_API && schema.$id in commandsSchemas) {
      continue;
    }
    fastify.addSchema(schema);
  }

  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Toolstack Instance API",
        description: "Documentation for controlling a single instance of Toolstack",
        version: "0.0.1",
      },
      servers: [
        {
          url: getBaseUrl(),
          description: "Local server",
        },
      ],
      paths: {}, // paths must be included even if it's an empty object
      components: {
        securitySchemes: {},
      },
    },
    refResolver: {
      buildLocalReference: (json, baseUri, fragment, i) => {
        return (json.$id as string) || `Fragment${i}`;
      },
    },
  });

  const hidden = { schema: { hide: true } };
  let reference: string | undefined;
  const ignoreTrailingSlash =
    fastify.initialConfig.routerOptions?.ignoreTrailingSlash ??
    fastify.initialConfig.ignoreTrailingSlash;
  if (!ignoreTrailingSlash)
    fastify.get("/documentation", hidden, (_request, reply) =>
      reply.redirect("/documentation/", 301),
    );
  fastify.get("/documentation/", hidden, (_request, reply) => {
    reference ??= renderApiReference(fastify.swagger());
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      )
      .send(reference);
  });
  fastify.get("/documentation/openapi.json", hidden, () => fastify.swagger());
  fastify.get("/documentation/openapi.yaml", hidden, (_request, reply) =>
    reply.type("application/yaml").send(fastify.swagger({ yaml: true })),
  );
};

export default fp(schemaPlugin);
