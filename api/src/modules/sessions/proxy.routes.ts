import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentFor, browserOriginAllowed } from "../../utils/api-key.js";
import { assertAgentCurrent } from "../../services/agent-access.js";
import { retryKey, retryOperation } from "../../utils/idempotency.js";
import {
  leaseInput,
  leaseFetchInput,
  proxyOutcome,
  proxyProfile,
  actor,
  proxyAdmin,
  ProxyError,
} from "../../services/proxy/types.js";
import { requireProxyIdentity } from "../../services/proxy/access.js";

export default async function proxyRoutes(server: FastifyInstance) {
  server.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: "invalid_proxy_request", message: "Invalid proxy parameters" });
    return reply.send(error);
  });
  server.addHook("preHandler", async (req) => {
    const principal = agentFor(req.raw);
    if (!principal) throw new ProxyError("proxy_authentication_required", 401);
    if (!browserOriginAllowed(req.raw)) throw new ProxyError("proxy_origin_not_allowed", 403);
    await assertAgentCurrent(principal);
  });
  const service = () => {
    if (!server.sessionPool.proxies) throw new ProxyError("proxy_service_unavailable", 503);
    return server.sessionPool.proxies;
  };
  const agent = (req: FastifyRequest) => {
    const value = agentFor(req.raw);
    if (!value) throw new ProxyError("proxy_authentication_required", 401);
    return value;
  };
  const id = (value: unknown) => z.string().uuid().parse(value);
  const contract = (description: string, body?: z.ZodType) => ({
    bodyLimit: body === leaseFetchInput ? 8_100_000 : 200_000,
    schema: {
      tags: ["Proxies"],
      description,
      ...(body ? { body: z.toJSONSchema(body, { target: "draft-07", io: "input" }) } : {}),
    },
    ...(body
      ? {
          validatorCompiler: () => (data: unknown) => {
            const result = body.safeParse(data);
            return result.success
              ? { value: result.data }
              : { error: new ProxyError("invalid_proxy_request", 400) };
          },
        }
      : {}),
  });
  const idempotent = <T>(req: FastifyRequest, run: () => Promise<T>) =>
    retryOperation(
      actor(agent(req)),
      `${req.method}:${req.routeOptions.url}`,
      retryKey(req.headers),
      { params: req.params, body: req.body },
      async (operation) => {
        operation?.markActed();
        return run();
      },
    );
  server.get(
    "/proxies/profiles",
    contract("List permitted profiles and credential configuration status"),
    (req) => service().profiles(agent(req)),
  );
  server.put<{ Params: { name: string } }>(
    "/proxies/profiles/:name",
    contract("Admin: replace a profile using environment credential references", proxyProfile),
    (req) => idempotent(req, () => service().putProfile(req.params.name, req.body, agent(req))),
  );
  server.delete<{ Params: { name: string } }>(
    "/proxies/profiles/:name",
    contract("Admin: delete an unused custom profile"),
    (req) => idempotent(req, () => service().deleteProfile(req.params.name, agent(req))),
  );
  server.get(
    "/proxies/leases",
    contract("List owned leases; admin sees this worker ledger"),
    (req) => service().list(agent(req)),
  );
  server.post(
    "/proxies/leases",
    contract(
      "Allocate and verify a metered lease; accepts Idempotency-Key",
      leaseInput.default({ profile: "core" }),
    ),
    (req) =>
      idempotent(req, async () => {
        const owner = agent(req),
          input = leaseInput.parse(req.body ?? {});
        await requireProxyIdentity(server.sessionPool, input, owner);
        return service().acquire(input, owner);
      }),
  );
  server.get<{ Params: { id: string } }>(
    "/proxies/leases/:id",
    contract("Read lease metadata without credentials"),
    (req) => service().get(id(req.params.id), agent(req)),
  );
  server.post<{ Params: { id: string } }>(
    "/proxies/leases/:id/release",
    contract("Release a standalone lease and abort its HTTP requests"),
    (req) => idempotent(req, () => service().release(id(req.params.id), agent(req))),
  );
  server.post<{ Params: { id: string } }>(
    "/proxies/leases/:id/renew",
    contract(
      "Extend an active lease within its profile TTL",
      z.object({ ttlSeconds: z.number().int().min(1).max(86400) }).strict(),
    ),
    (req) =>
      idempotent(req, () => {
        const input = z
          .object({ ttlSeconds: z.number().int().min(1).max(86400) })
          .strict()
          .parse(req.body);
        return service().renew(id(req.params.id), input.ttlSeconds, agent(req));
      }),
  );
  server.post<{ Params: { id: string } }>(
    "/proxies/leases/:id/fetch",
    contract("Bounded HTTP through the owned lease; base64 response body", leaseFetchInput),
    (req) =>
      idempotent(req, () => {
        const input = leaseFetchInput.parse(req.body);
        return service().fetch(id(req.params.id), input, agent(req));
      }),
  );
  server.post<{ Params: { id: string } }>(
    "/proxies/leases/:id/outcome",
    contract("Record a host outcome; blocked exits are quarantined for one hour", proxyOutcome),
    (req) =>
      idempotent(req, () => {
        const input = proxyOutcome.parse(req.body);
        return service().report(id(req.params.id), input.host, input.outcome, agent(req));
      }),
  );
  server.get("/proxies/health", contract("Admin: allocation and host outcome counters"), (req) =>
    service().health(agent(req)),
  );
  server.post<{ Params: { name: string } }>(
    "/proxies/identities/:name/rotate",
    contract(
      "Admin: explicitly rotate an idle identity for its next allocation",
      z.object({ confirm: z.literal(true) }).strict(),
    ),
    (req) =>
      idempotent(req, async () => {
        z.object({ confirm: z.literal(true) })
          .strict()
          .parse(req.body);
        if (server.sessionPool.identityBusy(req.params.name))
          throw new ProxyError("proxy_identity_in_use");
        return service().rotateIdentity(req.params.name, agent(req));
      }),
  );
  server.get(
    "/proxies/usage",
    contract("Observed upstream bytes, separate from provider billing"),
    async (req) => {
      const owner = agent(req),
        totals = await service().totals();
      return proxyAdmin(owner)
        ? totals
        : {
            date: totals.date,
            agent: owner.name,
            bytesToday: totals.agents[actor(owner)] ?? 0,
            totalBytes: totals.totalByAgent[actor(owner)] ?? 0,
            dailyBudgetBytes: owner.dailyBudgetBytes,
            units: totals.units,
          };
    },
  );
}
