import { sessionOptions } from "../../services/session-pool.js";
import { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ScrapeRequestBody,
  ScreenshotRequestBody,
  PDFRequestBody,
} from "../actions/actions.schema.js";
import { SessionContextSchema } from "../../services/context/types.js";

export type CredentialsOptions = z.infer<typeof SessionCredentials>;
export const SessionCredentials = z
  .object({
    autoSubmit: z.union([z.boolean(), z.never()]),
    blurFields: z.union([z.boolean(), z.never()]),
    exactOrigin: z.union([z.boolean(), z.never()]),
  })
  .partial()
  .optional()
  .describe("Configuration for session credentials");

const CreateSession = sessionOptions;

const SessionDetails = z.object({
  id: z.string().uuid().describe("Unique identifier for the session"),
  createdAt: z.string().datetime().describe("Timestamp when the session started"),
  status: z.enum(["starting", "live", "released", "failed"]).describe("Status of the session"),
  mode: z.enum(["agent", "quiet"]),
  identity: z.string().optional().describe("Named persistent profile, when requested"),
  endReason: z.string().optional(),
  temporaryProfileRemoved: z.boolean(),
  duration: z.number().int().describe("Duration of the session in milliseconds"),
  eventCount: z.number().int().describe("Number of events processed in the session"),
  dimensions: z
    .object({
      width: z.number(),
      height: z.number(),
    })
    .describe("Dimensions used for the session"),
  timeout: z.number().int().describe("Session timeout duration in milliseconds"),
  creditsUsed: z.number().int().describe("Amount of credits consumed by the session"),
  websocketUrl: z.string().describe("URL for the session's WebSocket connection"),
  debugUrl: z.string().describe("URL for a viewing the live browser instance for the session"),
  debuggerUrl: z.string().describe("URL for debugging the session"),
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

const SessionLiveDetailsResponse = SessionDetails.extend({
  pages: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      title: z.string(),
      favicon: z.string().nullable(),
    }),
  ),
});

const MultipleSessions = z.object({
  sessions: z.array(SessionDetails),
});

export type SessionsScrapeRequestBody = Omit<ScrapeRequestBody, "url">;
export type SessionsScrapeRequest = FastifyRequest<{ Body: SessionsScrapeRequestBody }>;

export type SessionsScreenshotRequestBody = Omit<ScreenshotRequestBody, "url">;
export type SessionsScreenshotRequest = FastifyRequest<{ Body: SessionsScreenshotRequestBody }>;

export type SessionsPDFRequestBody = Omit<PDFRequestBody, "url">;
export type SessionsPDFRequest = FastifyRequest<{ Body: SessionsPDFRequestBody }>;

export type CreateSessionBody = z.infer<typeof CreateSession>;
export type CreateSessionRequest = FastifyRequest<{ Body: CreateSessionBody }>;
export type SessionDetails = z.infer<typeof SessionDetails>;
export type MultipleSessions = z.infer<typeof MultipleSessions>;

export const browserSchemas = {
  CreateSession,
  SessionDetails,
  MultipleSessions,
  SessionContextSchema,
  ReleaseSession,
  SessionLiveDetailsResponse,
};

export default browserSchemas;
