import type { FastifyInstance } from "fastify";
import { agentFor, browserOriginAllowed } from "../../utils/api-key.js";
import { PublicError } from "../../utils/public-error.js";
import { assertAgentCurrent } from "../../services/agent-access.js";
import { libraryActor, libraryUser } from "../../services/library/contracts.js";
import { organizationContext } from "../../services/organization.js";
import { callLibrary } from "../../services/library/service.js";
import { libraryCommand } from "../../services/library/http.js";
import { attachmentContentDisposition } from "../../utils/content-disposition.js";

export async function libraryRoutes(server: FastifyInstance) {
  server.get("/v1/organization", async (req, reply) => {
    const agent = agentFor(req.raw);
    if (!agent) throw new PublicError("unauthorized", "Sign in to Toolstack", 401);
    if (!browserOriginAllowed(req.raw))
      throw new PublicError("forbidden_origin", "Use the Toolstack origin", 403);
    await assertAgentCurrent(agent);
    reply.header("cache-control", "no-store");
    const context = organizationContext(libraryUser(agent));
    return {
      organization: context.organization,
      membership: {
        id: context.membership.membershipId,
        userId: context.membership.userId,
        role: context.membership.role,
        orgId: context.organization.id,
      },
    };
  });
  let requests = 0;
  const admission = async (req: any, reply: any) => {
    const agent = agentFor(req.raw);
    if (!agent) throw new PublicError("unauthorized", "Sign in to Toolstack", 401);
    if (!browserOriginAllowed(req.raw))
      throw new PublicError("forbidden_origin", "Use the Toolstack origin", 403);
    await assertAgentCurrent(agent);
    if (requests >= 4)
      return reply
        .code(429)
        .header("retry-after", "1")
        .send({ message: "The content library is busy. Retry shortly." });
    requests++;
    let held = true;
    const release = () => {
      if (held) {
        held = false;
        requests--;
      }
    };
    reply.raw.once("finish", release);
    reply.raw.once("close", release);
  };
  const handler = async (req: any, reply: any) => {
    const agent = agentFor(req.raw);
    if (!agent) throw new PublicError("unauthorized", "Sign in to Toolstack", 401);
    if (!browserOriginAllowed(req.raw))
      throw new PublicError("forbidden_origin", "Use the Toolstack origin", 403);
    await assertAgentCurrent(agent);
    const parsed = libraryCommand(req.method, new URL(req.url, "http://localhost"), req.body);
    const value = await callLibrary(server.contentLibrary, libraryActor(agent), parsed.command);
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (parsed.binary) {
      reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", attachmentContentDisposition(value.name))
        .header("x-content-sha256", value.sha256)
        .header("etag", `"${value.sha256}"`)
        .header("content-length", value.bytes);
      return req.method === "HEAD" ? reply.send() : reply.send(Buffer.from(value.base64, "base64"));
    }
    return value;
  };
  server.route({
    method: ["GET", "POST"],
    url: "/v1/library",
    handler,
    bodyLimit: 24 * 1024 * 1024,
    onRequest: admission,
  });
  server.route({
    method: ["GET", "HEAD", "POST", "PUT"],
    url: "/v1/library/*",
    handler,
    bodyLimit: 24 * 1024 * 1024,
    onRequest: admission,
  });
}
