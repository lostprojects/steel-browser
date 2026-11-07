import { z } from "zod";
import type { SessionPool } from "../session-pool.js";
import { assertAgentCurrent } from "../agent-access.js";
import { retryOperation } from "../../utils/idempotency.js";
import {
  actor,
  leaseInput,
  leaseFetchInput,
  proxyOutcome,
  proxyProfile,
  proxyName,
  proxyAdmin,
  ProxyError,
} from "../proxy/types.js";
import { requireProxyIdentity } from "../proxy/access.js";
import type { Toolkit, ToolkitTool, ToolContext } from "./registry.js";

export function proxyToolkit(pool: SessionPool): Toolkit {
  const service = () => {
    if (!pool.proxies) throw new ProxyError("proxy_service_unavailable", 503);
    return pool.proxies;
  };
  const tool = (
    name: string,
    description: string,
    input: z.ZodObject,
    run: (args: Record<string, any>, context: ToolContext) => Promise<unknown>,
    options: { read?: boolean; admin?: boolean } = {},
  ): ToolkitTool => ({
    name,
    description,
    input: input.extend({
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .optional(),
    }),
    annotations: {
      readOnlyHint: options.read ?? false,
      destructiveHint: !options.read,
      openWorldHint: !options.read,
    },
    ...(options.admin ? { authorize: (context: ToolContext) => proxyAdmin(context.agent) } : {}),
    execute: async (args, context) => {
      await assertAgentCurrent(context.agent);
      context.assertAuthorized?.();
      context.signal.throwIfAborted();
      const { idempotencyKey, ...body } = args;
      const result = await retryOperation(
        actor(context.agent),
        name,
        idempotencyKey as string | undefined,
        body,
        async (operation) => {
          if (!options.read) operation?.markActed();
          return run(body, context);
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const lease = z.object({ id: z.string().uuid() }).strict();
  return {
    id: "proxies",
    name: "Toolstack Proxies",
    version: "2.0.0",
    description:
      "Managed proxy profiles, verified leases, identity continuity and metered HTTP/browser routes",
    authentication:
      "Uses your Toolstack key, profile permissions and private proxy budget. Provider secrets stay on the worker.",
    authorize: () => Boolean(pool.proxies),
    tools: [
      tool(
        "proxy_profiles",
        "List permitted profiles and configuration status before allocating. Only configured, funded Evomi products can carry traffic.",
        z.object({}).strict(),
        (_, c) => service().profiles(c.agent),
        { read: true },
      ),
      tool(
        "proxy_allocate",
        "Allocate a metered lease and verify its exit country and timezone. Costs a small probe request. Named identities preserve their existing exit and never fall back. Reuse idempotencyKey on retries.",
        leaseInput,
        async (args, c) => {
          const input = leaseInput.parse(args);
          await requireProxyIdentity(pool, input, c.agent);
          return service().acquire(input, c.agent, { signal: c.signal });
        },
      ),
      tool(
        "proxy_leases",
        "List your leases, including closed records. Admin sees the worker ledger.",
        z.object({}).strict(),
        (_, c) => service().list(c.agent),
        { read: true },
      ),
      tool(
        "proxy_get",
        "Read lease metadata, verified exit and observed byte counters. Proxy credentials are never returned.",
        lease,
        (a, c) => service().get(a.id, c.agent),
        { read: true },
      ),
      tool(
        "proxy_fetch",
        "Make a bounded HTTP request through your lease, sharing its exit and budget with an attached browser. Does not share browser cookies. Response body is base64.",
        lease.extend(leaseFetchInput.shape),
        (a, c) => {
          const { id, ...input } = a;
          return service().fetch(id, leaseFetchInput.parse(input), c.agent, c.signal);
        },
      ),
      tool(
        "proxy_release",
        "Close your standalone lease and abort its requests. Close an attached browser first. Releasing a closed lease is safe.",
        lease,
        (a, c) => service().release(a.id, c.agent),
      ),
      tool(
        "proxy_renew",
        "Extend an active lease within its profile TTL. Does not reset its budget or change its exit.",
        lease.extend({ ttlSeconds: z.number().int().min(1).max(86400) }),
        (a, c) => service().renew(a.id, a.ttlSeconds, c.agent),
      ),
      tool(
        "proxy_outcome",
        "Report a host outcome. Blocked exits are quarantined for that profile and host for one hour. Reports do not rotate named identities.",
        lease.extend(proxyOutcome.shape),
        (a, c) => service().report(a.id, a.host, a.outcome, c.agent),
      ),
      tool(
        "proxy_usage",
        "Read observed byte usage and remaining daily policy. This worker ledger is separate from Evomi account billing.",
        z.object({}).strict(),
        async (_, c) => {
          const totals = await service().totals();
          return proxyAdmin(c.agent)
            ? totals
            : {
                date: totals.date,
                agent: c.agent.name,
                bytesToday: totals.agents[actor(c.agent)] ?? 0,
                totalBytes: totals.totalByAgent[actor(c.agent)] ?? 0,
                dailyBudgetBytes: c.agent.dailyBudgetBytes,
                units: totals.units,
              };
        },
        { read: true },
      ),
      tool(
        "proxy_health",
        "Read profile allocation and host outcome counters.",
        z.object({}).strict(),
        (_, c) => service().health(c.agent),
        { read: true, admin: true },
      ),
      tool(
        "proxy_profile_put",
        "Create or replace a proxy profile. Credentials must reference an existing worker environment variable. Changes can revoke active routes on the next policy check.",
        z.object({ name: proxyName, profile: proxyProfile }).strict(),
        (a, c) => service().putProfile(a.name, a.profile, c.agent),
        { admin: true },
      ),
      tool(
        "proxy_profile_delete",
        "Delete an unused custom profile. Built-in profiles can be disabled with proxy_profile_put.",
        z.object({ name: proxyName }).strict(),
        (a, c) => service().deleteProfile(a.name, c.agent),
        { admin: true },
      ),
      tool(
        "proxy_identity_rotate",
        "Explicitly abandon an idle named identity's saved exit. The next allocation verifies a new route; browser cookies are retained. Requires confirm:true.",
        z.object({ name: proxyName, confirm: z.literal(true) }).strict(),
        async (a, c) => {
          if (pool.identityBusy(a.name)) throw new ProxyError("proxy_identity_in_use");
          return service().rotateIdentity(a.name, c.agent);
        },
        { admin: true },
      ),
    ],
  };
}
