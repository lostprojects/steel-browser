// OAuth is a hosted browser flow. Agent apps keep their own tokens; no local
// installer or copied account key is needed to approve an app connection.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GatewayError, GatewayStore, type Principal } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const TTL = 5 * 60_000;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
type Pending = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
  binding?: string;
  principal?: Principal;
  csrf?: string;
};

export class GatewayOAuth implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Pending>();
  readonly resource: URL;
  readonly clientsStore;
  readonly handler;
  readonly routes = new Set([
    "/authorize",
    "/token",
    "/register",
    "/revoke",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]);
  constructor(
    private store: GatewayStore,
    readonly origin: string,
  ) {
    this.resource = new URL("/mcp", origin);
    this.clientsStore = {
      getClient: (id: string) => store.oauthClient(id),
      registerClient: async (
        input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
      ) => {
        if (
          !input.redirect_uris?.length ||
          input.redirect_uris.length > 8 ||
          (input.client_name?.length ?? 0) > 100 ||
          ![undefined, "none", "client_secret_post"].includes(input.token_endpoint_auth_method)
        )
          throw new InvalidClientMetadataError("Unsupported client metadata");
        for (const value of input.redirect_uris) {
          const url = new URL(value);
          if (
            value.length > 2048 ||
            url.username ||
            url.password ||
            url.hash ||
            !(url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname)))
          )
            throw new InvalidClientMetadataError(
              "Use HTTPS or a loopback callback without credentials or a fragment",
            );
        }
        return store.registerOAuthClient({
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: input.client_name?.trim() || "Agent",
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method:
            input.token_endpoint_auth_method === "none" ? "none" : "client_secret_post",
          ...(input.client_secret
            ? {
                client_secret: input.client_secret,
                client_secret_expires_at: input.client_secret_expires_at,
              }
            : {}),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "browser",
        });
      },
    };
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      if (req.path === "/.well-known/oauth-protected-resource") {
        res.setHeader("access-control-allow-origin", "*");
        res.json({
          resource: this.resource.href,
          authorization_servers: [new URL(origin).href],
          scopes_supported: ["browser"],
          resource_name: "Toolstack",
        });
      } else next();
    });
    app.use(
      mcpAuthRouter({
        provider: this,
        issuerUrl: new URL(origin),
        resourceServerUrl: this.resource,
        scopesSupported: ["browser"],
        resourceName: "Toolstack",
        serviceDocumentationUrl: new URL("/connect", origin),
        authorizationOptions: { rateLimit: { windowMs: 60_000, max: 120 } },
        tokenOptions: { rateLimit: { windowMs: 60_000, max: 300 } },
        clientRegistrationOptions: { rateLimit: { windowMs: 60_000, max: 60 } },
      }),
    );
    this.handler = app;
  }
  private prune() {
    for (const entries of [this.pending, this.codes])
      for (const [id, value] of entries) if (value.expires <= Date.now()) entries.delete(id);
  }
  private target(resource?: URL) {
    if (resource && resource.href !== this.resource.href)
      throw new InvalidRequestError("The requested resource must be this Toolstack MCP endpoint");
  }
  private scopes(values?: string[]) {
    if (values?.some((scope) => scope !== "browser"))
      throw new InvalidScopeError("Only browser access is available");
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.prune();
    this.target(params.resource);
    this.scopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("Use S256 PKCE");
    if (this.pending.size >= 1000) throw new InvalidRequestError("Too many pending connections");
    const request = secret();
    this.pending.set(hash(request), { client, params, expires: Date.now() + TTL });
    res.redirect(303, "/connect?request=" + request);
  }
  review(request: string, principal: Principal, cookie: string) {
    this.prune();
    const pending = this.pending.get(hash(request));
    if (!pending || principal.grantId || !this.store.active(principal))
      throw new GatewayError(410, "Connection request expired; start again in your agent");
    const binding = hash(cookie);
    if (pending.binding && pending.binding !== binding)
      throw new GatewayError(403, "Connection request belongs to another browser sign-in");
    this.store.backend(principal);
    pending.binding = binding;
    pending.principal = principal;
    pending.csrf ??= secret();
    return {
      client: pending.client.client_name ?? "Agent",
      callback: new URL(pending.params.redirectUri).origin,
      local: loopback.has(new URL(pending.params.redirectUri).hostname),
      csrf: pending.csrf,
    };
  }
  approve(request: string, csrf: string, allow: boolean, principal: Principal, cookie: string) {
    this.prune();
    const pending = this.pending.get(hash(request));
    if (
      !pending ||
      !pending.binding ||
      pending.binding !== hash(cookie) ||
      pending.csrf !== csrf ||
      pending.principal?.userId !== principal.userId ||
      !this.store.active(principal)
    )
      throw new GatewayError(403, "Connection approval expired or does not match this sign-in");
    this.pending.delete(hash(request));
    const redirect = new URL(pending.params.redirectUri);
    if (allow) {
      if (this.codes.size >= 1000) throw new GatewayError(429, "Too many pending connections");
      const code = secret();
      this.codes.set(hash(code), { ...pending, expires: Date.now() + TTL });
      redirect.searchParams.set("code", code);
    } else redirect.searchParams.set("error", "access_denied");
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    redirect.searchParams.set("iss", new URL(this.origin).href);
    return { redirect: redirect.href };
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    this.prune();
    const pending = this.codes.get(hash(code));
    if (!pending || pending.client.client_id !== client.client_id)
      throw new InvalidGrantError("Authorization code expired or unavailable");
    return pending.params.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.prune();
    this.target(resource);
    const pending = this.codes.get(hash(code));
    this.codes.delete(hash(code));
    if (
      !pending?.principal ||
      pending.client.client_id !== client.client_id ||
      redirectUri !== pending.params.redirectUri
    )
      throw new InvalidGrantError("Authorization code does not match this client and callback");
    return this.store.issueOAuth(
      pending.principal,
      client.client_id,
      client.client_name ?? "Agent",
      this.resource.href,
    );
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.target(resource);
    this.scopes(scopes);
    const value = await this.store.refreshOAuth(client.client_id, refresh, this.resource.href);
    if (!value) throw new InvalidGrantError("Connection expired or disconnected; connect again");
    return value;
  }
  async verifyAccessToken(value: string) {
    const principal = this.store.authenticate(value);
    if (
      !principal?.grantId ||
      !principal.oauthClientId ||
      principal.resource !== this.resource.href
    )
      throw new InvalidTokenError("Agent connection expired or unavailable");
    return {
      token: value,
      clientId: principal.oauthClientId,
      scopes: ["browser"],
      expiresAt: Math.floor(principal.expires / 1000),
      resource: this.resource,
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }) {
    await this.store.revokeOAuthToken(client.client_id, request.token);
  }
}
