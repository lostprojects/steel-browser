// Describes existing accounts using metadata only. Do not read Chrome databases,
// export vault values, or treat saved profiles as proof of current authentication.
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SessionPool } from "./session-pool.js";
import type { Agent } from "./proxy/service.js";
import type { LoginService } from "./login.js";
import { identityVault, loginSites } from "./login.js";
import { vault, type Vault } from "./vault.js";
import { storeName } from "./shared-store.js";
import {
  ConnectionError,
  connectionConfiguration,
  connectionId,
  type ConnectionSettings,
  connectionConfigureInput,
  type ApiConnectionSettings,
  type ApiToolName,
} from "./connection-store.js";
import { PublicError } from "../utils/public-error.js";
import type { ToolRegistry, ToolContext } from "./toolkits/registry.js";

type Credential = Awaited<ReturnType<Vault["list"]>>[number];
type RoutingSnapshot = Awaited<ReturnType<SessionPool["routing"]["snapshot"]>>;
type Site = ReturnType<RoutingSnapshot["resolve"]>;
type LoginRecords = Awaited<ReturnType<LoginService["metadata"]>>;
const supportedVaults = new Set<string>(Object.values(loginSites).map((site) => site.vault));
const observation = z.object({
  site: storeName,
  status: z.string().regex(/^[a-z0-9_-]{1,100}$/i),
  check: z.string().regex(/^[a-z0-9_-]{1,100}$/i),
  at: z.string().datetime({ offset: true }),
  last_login_ok: z.string().datetime({ offset: true }).optional(),
});

export interface ConnectionObservation {
  site: string;
  status: string;
  check: string;
  observedAt: string;
  lastAuthenticatedAt: string | null;
}
interface ConnectionPermissions {
  canUse: boolean;
  canConfigure: boolean;
  canVerify?: boolean;
}
export interface BrowserConnection {
  id: `browser:${string}`;
  type: "browser";
  toolkit: "browser";
  label: string;
  identity: string;
  status:
    | "unverified"
    | "last_verified"
    | "verification_required"
    | "needs_login"
    | "disabled"
    | "disconnected";
  statusBasis: "last_recorded_observation";
  profileSaved: boolean;
  busy: boolean;
  defaultSite: string | null;
  sites: Array<{ site: string; origin: string; loginSite: string | null }>;
  credential: { name: string; scope: Credential["scope"]; available: boolean } | null;
  observations: ConnectionObservation[];
  permissions: ConnectionPermissions & { managed: boolean; allowedAgents?: string[] };
}
export interface VaultConnection {
  id: `vault:${string}`;
  type: "vault";
  toolkit: null;
  label: string;
  status: "credentials_available" | "locked";
  scope: Credential["scope"];
  lastUsed: string | null;
  permissions: ConnectionPermissions;
}
export interface ApiConnection {
  id: `api:${string}`;
  type: "api";
  toolkit: string;
  provider: string;
  label: string;
  status: "configured" | "disabled" | "disconnected" | "credential_missing" | "locked";
  credential: {
    name: string;
    field: string;
    scope: Credential["scope"] | null;
    available: boolean;
  };
  allowedTools: ApiToolName[];
  limits: { dailyCalls: number; dailyBudgetUSD: number };
  verification: { tool: string; estimatedCostUSD: number } | null;
  permissions: ConnectionPermissions & { allowedAgents?: string[] };
}
export type Connection = BrowserConnection | VaultConnection | ApiConnection;
export interface ConnectionCatalog {
  connections: Connection[];
  sharedStoreAvailable: boolean;
}
export interface ConnectionPage extends ConnectionCatalog {
  total: number;
  nextOffset: number | null;
}
export const connectionPagination = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

interface ProfileState {
  identity: string;
  config?: ConnectionSettings;
  saved: boolean;
  owned: boolean;
  credential?: Credential;
  observations?: ConnectionObservation[];
}
interface BrowserResolution {
  connection: BrowserConnection;
  defaultSite: string | null;
  routing: RoutingSnapshot;
}

function parseId(id: string): { type: "browser" | "vault" | "api"; name: string } {
  const value = connectionId.parse(id);
  const separator = value.indexOf(":");
  return {
    type: value.startsWith("browser:") ? "browser" : value.startsWith("api:") ? "api" : "vault",
    name: value.slice(separator + 1),
  };
}
function unavailable(sharedStoreAvailable: boolean): never {
  throw new ConnectionError(
    sharedStoreAvailable ? "connection_unavailable" : "connection_metadata_unavailable",
  );
}
function indexObservations(records: LoginRecords) {
  const result = new Map<string, ConnectionObservation[]>();
  for (const [key, value] of Object.entries(records)) {
    const identity = key.split("/")[0];
    if (!storeName.safeParse(identity).success) continue;
    const rows = result.get(identity) ?? [];
    result.set(identity, rows);
    const parsed = observation.safeParse(value);
    if (!parsed.success || key !== `${identity}/${parsed.data.site}`) continue;
    const record = parsed.data;
    rows.push({
      site: record.site,
      status: record.status,
      check: record.check,
      observedAt: record.at,
      lastAuthenticatedAt: record.last_login_ok ?? null,
    });
  }
  for (const rows of result.values())
    rows.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return result;
}

export class BrowserConnections {
  private catalog?: Pick<ToolRegistry, "apiBinding" | "apiTools">;
  useCatalog(catalog: Pick<ToolRegistry, "apiBinding" | "apiTools">) {
    this.catalog = catalog;
  }
  private registered(settings: ApiConnectionSettings, agent: Agent, requestedTool?: string) {
    if (!this.catalog)
      throw new PublicError("toolkit_unavailable", "API toolkit catalog is unavailable", 503);
    return this.catalog.apiBinding(
      settings,
      {
        agent,
        requestId: "connection-policy",
        signal: new AbortController().signal,
      },
      requestedTool,
    );
  }
  constructor(
    readonly pool: SessionPool,
    private readonly login: Pick<LoginService, "metadata">,
    private readonly credentials: Pick<Vault, "list" | "status"> = vault,
  ) {}

  private async savedProfiles() {
    try {
      return new Set(
        (await readdir(this.pool.profilesRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && storeName.safeParse(entry.name).success)
          .map((entry) => entry.name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
      throw error;
    }
  }
  private async profileSaved(identity: string) {
    try {
      return (await lstat(path.join(this.pool.profilesRoot, identity))).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private ownedProfiles(agent: Agent) {
    return new Set(
      this.pool
        .list()
        .filter((session) => this.pool.owner(session.id)?.name === agent.name)
        .flatMap((session) => (session.identity ? [session.identity] : [])),
    );
  }
  private async credentialSource(agent: Agent, name?: string) {
    try {
      return { value: await this.credentials.list(agent, name), available: true };
    } catch {
      return { value: await this.credentials.list(agent, name, "personal"), available: false };
    }
  }
  private async routingSource() {
    try {
      return { value: await this.pool.routing.snapshot(), available: true };
    } catch {
      return { value: await this.pool.routing.snapshot(false), available: false };
    }
  }

  // Listing and direct lookup use the same visibility and rendering rules.
  private visible(state: ProfileState, agent: Agent) {
    const { identity, config, credential, saved, owned, observations } = state;
    if (identityVault(identity) && !credential) return false;
    if (config && !agent.admin && !config.allowedAgents.includes(agent.name)) return false;
    if (!config && !agent.admin && !credential && !owned) return false;
    return !!(
      config ||
      saved ||
      owned ||
      observations ||
      (credential?.name === identity && supportedVaults.has(identity))
    );
  }
  private browser(
    state: ProfileState,
    agent: Agent,
    routing: RoutingSnapshot,
    sites: Site[],
  ): BrowserResolution {
    const { identity, config, credential } = state;
    const associated = [...sites];
    const configuredSite = config?.site ? routing.resolve(config.site) : undefined;
    if (configuredSite && !associated.some((site) => site.site === configuredSite.site))
      associated.unshift(configuredSite);
    const observations = state.observations ?? [];
    const last = observations[0];
    const status: BrowserConnection["status"] = !last
      ? "unverified"
      : last.status === "ok"
        ? "last_verified"
        : /code|two_factor|verification/.test(last.status + " " + last.check)
          ? "verification_required"
          : "needs_login";
    const connection: BrowserConnection = {
      id: `browser:${identity}`,
      type: "browser",
      toolkit: "browser",
      label: config?.label ?? identity,
      identity,
      status: config?.disconnected
        ? "disconnected"
        : config?.enabled === false
          ? "disabled"
          : status,
      statusBasis: "last_recorded_observation",
      profileSaved: state.saved,
      busy: this.pool.identityBusy(identity),
      defaultSite: configuredSite?.site ?? associated[0]?.site ?? null,
      sites: associated.map((site) => ({
        site: site.site,
        origin: new URL(site.url).origin,
        loginSite: site.loginSite,
      })),
      credential: credential
        ? {
            name: credential.name,
            scope: credential.scope,
            available: this.credentials.status === "open",
          }
        : null,
      observations,
      permissions: {
        canUse: config?.enabled !== false && !config?.disconnected,
        canConfigure: !!agent.admin,
        managed: !!config,
        ...(agent.admin && config ? { allowedAgents: config.allowedAgents } : {}),
      },
    };
    return { connection, defaultSite: config?.site ?? connection.defaultSite, routing };
  }
  private vaultConnection(credential: Credential, agent: Agent): VaultConnection {
    return {
      id: `vault:${credential.name}`,
      type: "vault",
      toolkit: null,
      label: credential.name,
      status: this.credentials.status === "open" ? "credentials_available" : "locked",
      scope: credential.scope,
      lastUsed: credential.lastUsed,
      permissions: { canUse: true, canConfigure: !!agent.admin },
    };
  }
  private apiConnection(
    name: string,
    settings: ApiConnectionSettings,
    agent: Agent,
    credential?: Credential,
  ): ApiConnection | undefined {
    if (!agent.admin && (!settings.allowedAgents.includes(agent.name) || !credential)) return;
    const available =
      !!credential?.fields.includes(settings.credentialField) && this.credentials.status === "open";
    const permitted =
      this.catalog?.apiTools(settings.provider, {
        agent,
        requestId: "connection-policy",
        signal: new AbortController().signal,
      }) ?? [];
    const allowedTools = settings.allowedTools.filter((tool) => permitted.includes(tool));
    if (!agent.admin && !allowedTools.length) return;
    let verification: ApiConnection["verification"] = null;
    try {
      const operation = this.registered(settings, agent).verification;
      if (operation && allowedTools.includes(operation.tool))
        verification = { tool: operation.tool, estimatedCostUSD: operation.estimatedCostUSD };
    } catch {
      /* A missing toolkit cannot provide a live verification operation. */
    }
    return {
      id: `api:${name}`,
      type: "api",
      toolkit: settings.provider,
      provider: settings.provider,
      label: settings.label,
      status: settings.disconnected
        ? "disconnected"
        : !settings.enabled
          ? "disabled"
          : !credential?.fields.includes(settings.credentialField)
            ? "credential_missing"
            : this.credentials.status !== "open"
              ? "locked"
              : "configured",
      credential: {
        name: settings.vault,
        field: settings.credentialField,
        scope: credential?.scope ?? null,
        available,
      },
      allowedTools,
      limits: { dailyCalls: settings.dailyCalls, dailyBudgetUSD: settings.dailyBudgetUSD },
      verification,
      permissions: {
        canUse: settings.enabled && !settings.disconnected && available && allowedTools.length > 0,
        canConfigure: !!agent.admin,
        canVerify: !!verification && settings.enabled && !settings.disconnected && available,
        ...(agent.admin ? { allowedAgents: settings.allowedAgents } : {}),
      },
    };
  }

  async list(agent: Agent): Promise<ConnectionCatalog> {
    const [saved, configs, credentials, routing, records, apis] = await Promise.all([
      this.savedProfiles(),
      this.pool.connectionStore.list(),
      this.credentialSource(agent),
      this.routingSource(),
      this.login.metadata(),
      this.pool.connectionStore.listApis(),
    ]);
    const observations = indexObservations(records);
    const owned = this.ownedProfiles(agent);
    const permitted = new Map(credentials.value.map((entry) => [entry.name, entry]));
    const sites = new Map<string, Site[]>();
    for (const site of routing.value.registry()) {
      if (!site.identity) continue;
      const rows = sites.get(site.identity) ?? [];
      rows.push(site);
      sites.set(site.identity, rows);
    }
    const identities = new Set([
      ...saved,
      ...Object.keys(configs),
      ...observations.keys(),
      ...owned,
    ]);
    for (const entry of credentials.value)
      if (supportedVaults.has(entry.name)) identities.add(entry.name);
    const connections: Connection[] = [];
    const bound = new Set<string>();
    for (const identity of [...identities].sort()) {
      if (!storeName.safeParse(identity).success) continue;
      const credentialName = identityVault(identity);
      const state: ProfileState = {
        identity,
        saved: saved.has(identity),
        owned: owned.has(identity),
        config: Object.hasOwn(configs, identity) ? configs[identity] : undefined,
        credential: credentialName ? permitted.get(credentialName) : undefined,
        observations: observations.get(identity),
      };
      if (!this.visible(state, agent)) continue;
      const { connection } = this.browser(state, agent, routing.value, sites.get(identity) ?? []);
      connections.push(connection);
      if (connection.credential) bound.add(connection.credential.name);
    }
    for (const name of Object.keys(apis).sort()) {
      const settings = apis[name];
      const connection = this.apiConnection(name, settings, agent, permitted.get(settings.vault));
      if (connection) {
        connections.push(connection);
        bound.add(settings.vault);
      }
    }
    for (const entry of credentials.value)
      if (!bound.has(entry.name)) connections.push(this.vaultConnection(entry, agent));
    return { connections, sharedStoreAvailable: credentials.available && routing.available };
  }

  async page(agent: Agent, options: unknown = {}): Promise<ConnectionPage> {
    const { limit, offset } = connectionPagination.parse(options);
    const catalog = await this.list(agent);
    const total = catalog.connections.length;
    return {
      ...catalog,
      connections: catalog.connections.slice(offset, offset + limit),
      total,
      nextOffset: offset + limit < total ? offset + limit : null,
    };
  }

  private async resolveBrowser(identity: string, agent: Agent): Promise<BrowserResolution> {
    const credentialName = identityVault(identity);
    const [config, saved, credentials, records] = await Promise.all([
      this.pool.connectionStore.get(identity),
      this.profileSaved(identity),
      credentialName
        ? this.credentialSource(agent, credentialName)
        : Promise.resolve({ value: [], available: true }),
      this.login.metadata(identity),
    ]);
    const state: ProfileState = {
      identity,
      config,
      saved,
      owned: this.ownedProfiles(agent).has(identity),
      credential: credentials.value.find((entry) => entry.name === credentialName),
      observations: indexObservations(records).get(identity),
    };
    if (!this.visible(state, agent)) unavailable(credentials.available);
    const routing = await this.routingSource();
    return this.browser(state, agent, routing.value, routing.value.registry(identity));
  }
  private async resolveVault(name: string, agent: Agent) {
    const source = await this.credentialSource(agent, name);
    const credential = source.value.find((entry) => entry.name === name);
    if (!credential) unavailable(source.available);
    return this.vaultConnection(credential, agent);
  }
  private async resolveApi(name: string, agent: Agent) {
    const settings = await this.pool.connectionStore.getApi(name);
    if (!settings || (!agent.admin && !settings.allowedAgents.includes(agent.name)))
      unavailable(true);
    const credentials = await this.credentialSource(agent, settings.vault);
    const connection = this.apiConnection(
      name,
      settings,
      agent,
      credentials.value.find((entry) => entry.name === settings.vault),
    );
    if (!connection) unavailable(credentials.available);
    return { connection, settings };
  }
  async authorizeApi(id: string, tool: ApiToolName, agent: Agent) {
    const target = parseId(id);
    if (target.type !== "api") throw new ConnectionError("invalid_connection");
    const resolved = await this.resolveApi(target.name, agent);
    if (!resolved.settings.enabled || resolved.settings.disconnected)
      throw new PublicError("connection_disabled", "This API connection is disabled", 403);
    if (!resolved.settings.allowedTools.includes(tool))
      throw new PublicError(
        "tool_forbidden",
        "This tool is not permitted on the API connection",
        403,
      );
    if (!resolved.connection.credential.available)
      throw new PublicError(
        "provider_auth_required",
        "The API credential is missing or locked",
        401,
      );
    this.registered(resolved.settings, agent, tool);
    return { ...resolved.settings, credentialScope: resolved.connection.credential.scope };
  }
  async get(id: string, agent: Agent): Promise<Connection> {
    const target = parseId(id);
    if (target.type === "browser")
      return (await this.resolveBrowser(target.name, agent)).connection;
    if (target.type === "api") return (await this.resolveApi(target.name, agent)).connection;
    return this.resolveVault(target.name, agent);
  }

  async select(id: string, input: Record<string, unknown>, agent: Agent) {
    const target = parseId(id);
    if (target.type !== "browser") {
      await this.get(id, agent);
      throw new ConnectionError("connection_unmapped");
    }
    const resolved = await this.resolveBrowser(target.name, agent);
    await this.pool.connectionStore.assertProfile(target.name, agent);
    const identity = resolved.connection.identity;
    if (
      (input.identity !== undefined && input.identity !== identity) ||
      (input.profile !== undefined && input.profile !== identity)
    )
      throw new ConnectionError("invalid_connection");
    const site = input.site ?? (input.targetUrl ? undefined : resolved.defaultSite);
    const selector = site ?? input.targetUrl;
    if (selector !== undefined) {
      if (typeof selector !== "string") throw new ConnectionError("invalid_connection");
      const route = resolved.routing.resolve(selector);
      if (route.identity && route.identity !== identity)
        throw new ConnectionError("connection_conflict");
    }
    const { connection: _connection, ...options } = input;
    return { ...options, identity, ...(site ? { site } : {}) };
  }

  async configure(
    id: string,
    input: unknown,
    agent: Agent,
  ): Promise<BrowserConnection | ApiConnection> {
    if (!agent.admin) throw new ConnectionError("connection_forbidden");
    const target = parseId(id);
    if (target.type === "api") {
      const data = connectionConfigureInput.parse(input);
      if (!data.api || data.site !== undefined) throw new ConnectionError("invalid_connection");
      const binding = {
        ...data.api,
        allowedTools:
          data.api.allowedTools ??
          this.catalog?.apiTools(data.api.provider, {
            agent,
            requestId: "connection-policy",
            signal: new AbortController().signal,
          }) ??
          [],
      };
      this.registered(
        {
          ...binding,
          label: data.label ?? target.name,
          allowedAgents: data.allowedAgents ?? ["admin"],
        },
        agent,
      );
      const credential = (await this.credentialSource(agent, data.api.vault)).value.find(
        (entry) => entry.name === data.api!.vault,
      );
      if (!credential || !credential.fields.includes(data.api.credentialField))
        throw new PublicError(
          "provider_auth_required",
          "Store the API key in the permitted vault entry first",
          401,
        );
      await this.pool.connectionStore.putApi(
        target.name,
        {
          ...binding,
          label: data.label ?? target.name,
          allowedAgents: data.allowedAgents ?? ["admin"],
        },
        agent,
      );
      return (await this.resolveApi(target.name, agent)).connection;
    }
    if (target.type !== "browser") throw new ConnectionError("invalid_connection");
    const data = connectionConfiguration.parse(input);
    if (data.site) {
      const site = (await this.routingSource()).value.resolve(data.site);
      if (site.identity && site.identity !== target.name)
        throw new ConnectionError("connection_conflict");
    }
    const credentialName = identityVault(target.name);
    if (credentialName) {
      const credentials = await this.credentialSource(agent, credentialName);
      if (!credentials.value.some((entry) => entry.name === credentialName))
        unavailable(credentials.available);
    }
    await this.pool.connectionStore.configure(target.name, data, agent);
    return (await this.resolveBrowser(target.name, agent)).connection;
  }
  async access(id: string, enabled: boolean, disconnect: boolean, agent: Agent) {
    await this.get(id, agent);
    await this.pool.connectionStore.access(id, agent, enabled, disconnect);
    return this.get(id, agent);
  }
}
