import { sessionOptions } from "../../services/session-pool.js";
import { z } from "zod";
import { SessionContextSchema } from "../../services/context/types.js";
import { connectionId } from "../../services/connection-store.js";

const CreateSession = sessionOptions.safeExtend({ connection: connectionId.optional() });

const SessionDetails = z.object({
  deliveryVersion: z
    .literal(1)
    .optional()
    .describe("Verified binary delivery protocol supported by this session"),
  id: z.string().uuid().describe("Unique identifier for the session"),
  createdAt: z.string().datetime().describe("Timestamp when the session started"),
  status: z.enum(["starting", "live", "released", "failed"]).describe("Status of the session"),
  mode: z.enum(["agent", "quiet"]),
  browserCapabilities: z
    .object({
      input: z.enum(["native", "cdp"]),
      capture: z.enum(["display", "page"]),
      fullPageCapture: z.boolean(),
      elementCapture: z.boolean(),
      captureQuality: z.boolean(),
      pdf: z.boolean(),
      networkIdle: z.boolean(),
    })
    .describe("Browser operations supported before command execution"),
  identity: z.string().optional().describe("Named persistent profile, when requested"),
  proxyLeaseId: z.string().uuid().optional().describe("Managed proxy lease; contains no provider credentials"),
  site: z.string().optional(),
  caller: z.string().optional(),
  last_login_ok: z.string().optional(),
  viewAvailable: z.boolean().describe("Whether this identity permits a live browser view"),
  exit: z
    .object({ ip: z.string(), timezone: z.string(), country: z.string(), region: z.string() })
    .optional(),
  challenge: z.object({ status: z.string(), kind: z.string(), url: z.string() }).optional(),
  directBytes: z.number().nonnegative(),
  endReason: z.string().optional(),
  temporaryProfileRemoved: z.boolean(),
  duration: z.number().int().describe("Duration of the session in milliseconds"),
  eventCount: z
    .number()
    .int()
    .describe("Legacy compatibility field; use /v1/logs/stats for event counts"),
  dimensions: z
    .object({
      width: z.number(),
      height: z.number(),
    })
    .describe("Dimensions used for the session"),
  timeout: z.number().int().describe("Session timeout duration in milliseconds"),
  creditsUsed: z
    .number()
    .int()
    .describe("Legacy compatibility field; this service meters proxy bytes"),
  websocketUrl: z.string().describe("URL for the session's WebSocket connection"),
  debugUrl: z.string().describe("URL for a viewing the live browser instance for the session"),
  debuggerUrl: z.string().describe("Legacy alias for the session viewer URL"),
  sessionViewerUrl: z.string().describe("URL to view session details"),
  noVncUrl: z.string().describe("Authenticated live display view"),
  display: z.string().optional(),
  commandMethods: z.array(z.string()).optional().describe("CDP methods used by quiet commands"),
  userAgent: z.string().optional().describe("User agent string used in the session"),
  proxyTxBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("Amount of data transmitted through the proxy"),
  proxyRxBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("Amount of data received through the proxy"),
  proxyTraffic: z
    .array(
      z.object({
        hostname: z.string(),
        txBytes: z.number().nonnegative(),
        rxBytes: z.number().nonnegative(),
      }),
    )
    .describe("Proxy bytes by hostname, including open tunnels; no URLs or credentials"),
});

const ReleaseSession = SessionDetails.merge(
  z.object({ success: z.boolean().describe("Indicates if the session was successfully released") }),
);

const MultipleSessions = z.object({
  sessions: z.array(SessionDetails),
});

export const browserSchemas = {
  CreateSession,
  SessionDetails,
  MultipleSessions,
  SessionContextSchema,
  ReleaseSession,
};

export default browserSchemas;
