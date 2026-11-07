// Stores account references and grants only. Passwords, cookies and tokens belong in
// the existing vault/profile stores and must never be copied into this file.
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Agent } from "./proxy-manager.js";
import { storeName } from "./shared-store.js";
import { PublicError } from "../utils/public-error.js";

export const connectionId = z
  .string()
  .regex(/^(?:browser|vault|api):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => storeName.safeParse(value.slice(value.indexOf(":") + 1)).success);
export const connectionConfiguration = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    site: z.string().trim().min(1).max(2048).nullable().optional(),
    allowedAgents: z.array(storeName).min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const settings = z
  .object({
    label: z.string().min(1).max(100),
    site: z.string().min(1).max(2048).nullable(),
    allowedAgents: z.array(storeName).min(1).max(64),
    enabled: z.boolean().default(true),
    disconnected: z.boolean().default(false),
  })
  .strict();
// Names describe registered capabilities. Provider-specific names and pricing
// belong in trusted toolkit modules, never in the persistence schema.
export const toolkitName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const apiToolName = toolkitName;
export type ApiToolName = z.infer<typeof apiToolName>;
export const apiBinding = z
  .object({
    provider: toolkitName,
    vault: storeName,
    credentialField: storeName.default("apiKey"),
    allowedTools: z.array(apiToolName).min(1).max(100).optional(),
    dailyCalls: z.number().int().min(1).max(1000).default(100),
    dailyBudgetUSD: z.number().min(0.001).max(100).default(0.1),
    enabled: z.boolean().default(true),
    disconnected: z.boolean().default(false),
  })
  .strict();
export const connectionConfigureInput = connectionConfiguration.extend({
  api: apiBinding.optional(),
});
export const apiSettings = apiBinding.extend({
  allowedTools: z.array(apiToolName).min(1).max(100),
  label: z.string().trim().min(1).max(100),
  allowedAgents: z.array(storeName).min(1).max(64),
});
export type ApiConnectionSettings = z.infer<typeof apiSettings>;
const stateSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(storeName, settings),
    apis: z.record(storeName, apiSettings).default({}),
  })
  .strict();
export type ConnectionSettings = z.infer<typeof settings>;

const errors = {
  connection_unavailable: [404, "Connection unavailable for this agent"],
  connection_forbidden: [403, "Connection access is not permitted for this agent"],
  connection_conflict: [409, "Site requires a different browser identity"],
  connection_unmapped: [409, "This connection has no browser profile mapping"],
  connection_metadata_unavailable: [503, "Shared connection metadata is unavailable"],
  invalid_connection: [400, "Supply matching connection, identity and site parameters"],
} as const;
export class ConnectionError extends PublicError {
  constructor(code: keyof typeof errors) {
    super(code, errors[code][1], errors[code][0]);
  }
}

export class ConnectionStore {
  private state: z.infer<typeof stateSchema> = { version: 1, profiles: {}, apis: {} };
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(readonly file: string) {
    this.ready = this.load();
    // Consumers await ready and fail closed; construction must not create an
    // unhandled rejection before the worker finishes registering its routes.
    void this.ready.catch(() => undefined);
  }
  private async load() {
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Connection permissions could not be loaded; access refused");
    }
  }
  async list() {
    await this.ready;
    await this.serial;
    return structuredClone(this.state.profiles);
  }
  async get(identity: string): Promise<ConnectionSettings | undefined> {
    await this.ready;
    await this.serial;
    return Object.hasOwn(this.state.profiles, identity)
      ? structuredClone(this.state.profiles[identity])
      : undefined;
  }
  async listApis() {
    await this.ready;
    await this.serial;
    return structuredClone(this.state.apis);
  }
  async getApi(name: string): Promise<ApiConnectionSettings | undefined> {
    await this.ready;
    await this.serial;
    return Object.hasOwn(this.state.apis, name)
      ? structuredClone(this.state.apis[name])
      : undefined;
  }
  async assertProfile(identity: string, agent: Agent) {
    const config = await this.get(identity);
    if (config && (!config.enabled || config.disconnected))
      throw new PublicError("connection_disabled", "This browser connection is disabled", 403);
    if (config && !agent.admin && !config.allowedAgents.includes(agent.name))
      throw new ConnectionError("connection_forbidden");
  }
  async configure(identity: string, input: unknown, agent: Agent) {
    if (!agent.admin) throw new ConnectionError("connection_forbidden");
    storeName.parse(identity);
    const data = connectionConfiguration.parse(input);
    await this.change((next) => {
      const previous = Object.hasOwn(next.profiles, identity) ? next.profiles[identity] : undefined;
      next.profiles[identity] = {
        label: data.label ?? previous?.label ?? identity,
        site: data.site !== undefined ? data.site : (previous?.site ?? null),
        allowedAgents: [...new Set(data.allowedAgents ?? previous?.allowedAgents ?? ["admin"])],
        enabled: data.enabled ?? previous?.enabled ?? true,
        disconnected: data.enabled === true ? false : (previous?.disconnected ?? false),
      };
    });
  }
  async putApi(name: string, input: ApiConnectionSettings, agent: Agent) {
    if (!agent.admin) throw new ConnectionError("connection_forbidden");
    storeName.parse(name);
    const data = apiSettings.parse(input);
    await this.change((next) => {
      next.apis[name] = data;
    });
  }
  async access(id: string, agent: Agent, enabled: boolean, disconnect = false) {
    if (!agent.admin) throw new ConnectionError("connection_forbidden");
    connectionId.parse(id);
    const [kind, name] = id.split(":");
    await this.change((next) => {
      if (kind === "vault") throw new ConnectionError("connection_unmapped");
      const target = kind === "api" ? next.apis : next.profiles;
      const existing = Object.hasOwn(target, name) ? target[name] : undefined;
      if (!existing && kind === "api") throw new ConnectionError("connection_unavailable");
      target[name] = {
        ...(existing ?? { label: name, site: null, allowedAgents: ["admin"] }),
        enabled,
        disconnected: disconnect,
      } as (typeof target)[string];
    });
  }
  private async change(update: (state: z.infer<typeof stateSchema>) => void) {
    await this.ready;
    const work = this.serial.then(async () => {
      const next = structuredClone(this.state);
      update(next);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + ".tmp", JSON.stringify(next), { mode: 0o600 });
      const handle = await open(this.file + ".tmp", "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(this.file + ".tmp", this.file);
      this.state = next;
    });
    this.serial = work.catch(() => undefined);
    await work;
  }
}
