// The gateway owns membership and explicitly shared configuration. It must not
// store browsing activity or allow administrators to impersonate claimed users.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  currentOrganization,
  organizationMember,
  type Organization,
  type MembershipIdentity,
} from "../services/organization.js";
import {
  credentialFields,
  sharedSite,
  sharedSnapshot,
  storeName,
  type SharedSnapshot,
} from "../services/shared-store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const secret = z.string().min(32).max(256);
const keySchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  hash: digest,
  created: z.string(),
});
const userSchema = z.object({
  id: storeName,
  name: z.string().min(1).max(100),
  backendUrl: z.string().url(),
  backendKey: secret,
  sharedHash: digest,
  disabled: z.boolean(),
  claimed: z.boolean(),
  keys: z.array(keySchema),
  invite: z.object({ hash: digest, expires: z.number() }).optional(),
});
const oauthClientSchema = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number(),
  client_name: z.string(),
  redirect_uris: z.array(z.string().url()),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post"]),
  client_secret: z.string().optional(),
  client_secret_expires_at: z.number().optional(),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  scope: z.string(),
});
const oauthGrantSchema = z.object({
  id: z.string().uuid(),
  userId: storeName,
  parentKeyId: z.string(),
  clientId: z.string(),
  resource: z.string().url(),
  label: z.string(),
  created: z.string(),
  expires: z.number(),
  refreshHash: digest,
  previousRefreshHashes: z.array(digest),
  access: z.array(z.object({ hash: digest, expires: z.number() })),
});
const stateSchema = z.object({
  version: z.literal(2),
  orgId: z.string().uuid(),
  users: z.array(userSchema),
  shared: sharedSnapshot,
  credentialGrants: z.record(storeName, z.array(storeName).min(1).max(100)).default({}),
  oauthClients: z.array(oauthClientSchema).default([]),
  oauthGrants: z.array(oauthGrantSchema).default([]),
});
type State = z.infer<typeof stateSchema>;
type User = State["users"][number];
export type Principal = MembershipIdentity & {
  userId: string;
  keyId: string;
  admin: boolean;
  expires: number;
  grantId?: string;
  tokenHash?: string;
  oauthClientId?: string;
  resource?: string;
};
export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const registration = z
  .object({
    id: storeName,
    name: z.string().trim().min(1).max(100),
    backendUrl: z.string().url(),
    backendKey: secret,
    sharedKey: secret,
  })
  .strict();
export type Registration = z.infer<typeof registration>;

export class GatewayStore extends EventEmitter {
  private state: State;
  private serial: Promise<unknown> = Promise.resolve();
  private sessions = new Map<string, Principal>();
  private readonly encryptionKey: Buffer;
  private readonly adminHash: string;
  readonly ready: Promise<void>;
  constructor(
    readonly file: string,
    encryptionKey: string,
    adminKey: string,
    readonly organization: Organization = currentOrganization(),
  ) {
    super();
    this.state = stateSchema.parse({
      version: 2,
      orgId: this.organization.id,
      users: [],
      shared: { credentials: {}, sites: {} },
    });
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey) || !secret.safeParse(adminKey).success)
      throw new Error("Configure a 32-byte GATEWAY_STORE_KEY and a strong STEEL_API_KEY");
    this.encryptionKey = Buffer.from(encryptionKey, "hex");
    this.adminHash = hash(adminKey);
    this.ready = this.load();
  }
  private async load() {
    try {
      const bytes = await readFile(this.file);
      if (bytes.subarray(0, 4).toString() !== "SG01" || bytes.length < 33) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.encryptionKey, bytes.subarray(4, 16));
      cipher.setAAD(Buffer.from("steel-gateway-v1"));
      cipher.setAuthTag(bytes.subarray(16, 32));
      const decoded = JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]).toString(),
      );
      const legacy = decoded.version === 1;
      this.state = stateSchema.parse(
        legacy ? { ...decoded, version: 2, orgId: decoded.orgId ?? this.organization.id } : decoded,
      );
      if (this.state.orgId && this.state.orgId !== this.organization.id)
        throw new Error("Gateway organization mismatch");
      if (legacy) {
        await this.saveState(this.state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Gateway store could not be decrypted or validated; startup refused");
    }
  }
  private async saveState(next: State) {
    next.orgId = this.organization.id;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from("steel-gateway-v1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(
      this.file + ".tmp",
      Buffer.concat([Buffer.from("SG01"), iv, cipher.getAuthTag(), encrypted]),
      { mode: 0o600 },
    );
    const handle = await open(this.file + ".tmp", "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.file + ".tmp", this.file);
  }
  private async change<T>(fn: (state: State) => T): Promise<T> {
    await this.ready;
    const work = this.serial.then(async () => {
      const next = structuredClone(this.state);
      const result = fn(next);
      if (Buffer.byteLength(JSON.stringify(next.shared)) > 3_000_000)
        throw new GatewayError(413, "Shared store exceeds its size limit");
      await this.saveState(next);
      this.state = next;
      this.emit("changed");
      return result;
    });
    this.serial = work.catch(() => undefined);
    return work;
  }
  authenticate(value?: string): Principal | undefined {
    if (!value || value.length > 512) return;
    const candidate = hash(value);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(this.adminHash)))
      return {
        ...organizationMember("owner", this.organization),
        keyId: "bootstrap",
        admin: true,
        expires: Infinity,
      };
    for (const user of this.state.users) {
      if (user.disabled) continue;
      const key = user.keys.find((key) => key.hash === candidate);
      if (key)
        return {
          ...organizationMember(user.id, this.organization),
          keyId: key.id,
          admin: false,
          expires: Infinity,
        };
    }
    for (const grant of this.state.oauthGrants) {
      const access = grant.access.find((entry) => entry.hash === candidate);
      const principal = access && {
        ...organizationMember(grant.userId, this.organization),
        keyId: grant.id,
        admin: false,
        expires: access.expires,
        grantId: grant.id,
        tokenHash: candidate,
        oauthClientId: grant.clientId,
        resource: grant.resource,
      };
      if (principal && this.active(principal)) return principal;
    }
  }
  active(principal: Principal) {
    const expected = organizationMember(principal.userId, this.organization);
    if (principal.orgId !== expected.orgId || principal.membershipId !== expected.membershipId)
      return false;
    if (principal.expires <= Date.now()) return false;
    if (principal.admin) return principal.userId === "owner" && principal.keyId === "bootstrap";
    if (principal.grantId) {
      const grant = this.state.oauthGrants.find((entry) => entry.id === principal.grantId);
      return (
        !!grant &&
        grant.userId === principal.userId &&
        this.grantActive(grant) &&
        grant.access.some(
          (entry) => entry.hash === principal.tokenHash && entry.expires > Date.now(),
        )
      );
    }
    const user = this.state.users.find((user) => user.id === principal.userId);
    return !!user && !user.disabled && user.keys.some((key) => key.id === principal.keyId);
  }
  cookie(value?: string) {
    if (!value) return;
    const principal = this.sessions.get(hash(value));
    return principal && this.active(principal) ? principal : undefined;
  }
  login(principal: Principal) {
    if (principal.grantId)
      throw new GatewayError(403, "Agent connections cannot sign in to account settings");
    for (const [key, value] of this.sessions) if (!this.active(value)) this.sessions.delete(key);
    if (this.sessions.size >= 10000) throw new GatewayError(429, "Too many browser logins");
    const value = token();
    this.sessions.set(hash(value), { ...principal, expires: Date.now() + 12 * 60 * 60 * 1000 });
    return value;
  }
  logout(value?: string) {
    if (value) {
      const current = this.sessions.get(hash(value));
      if (current) current.expires = 0;
      this.sessions.delete(hash(value));
      this.emit("changed");
    }
  }
  backend(principal: Principal) {
    if (!this.active(principal)) throw new GatewayError(401, "Authentication required");
    const user = this.state.users.find((user) => user.id === principal.userId && !user.disabled);
    if (!user) throw new GatewayError(503, "Your browser worker has not been configured");
    return { url: user.backendUrl, key: user.backendKey };
  }
  users() {
    return this.state.users.map(({ id, name, disabled, claimed }) => ({
      id,
      ...organizationMember(id, this.organization),
      name,
      disabled,
      claimed,
    }));
  }
  async register(input: Registration) {
    return this.change((state) => {
      if (state.users.length >= 100) throw new GatewayError(409, "User limit reached");
      if (
        state.users.some(
          (user) =>
            user.id === input.id ||
            user.backendUrl === input.backendUrl ||
            user.backendKey === input.backendKey ||
            user.sharedHash === hash(input.sharedKey),
        )
      )
        throw new GatewayError(409, "User and worker credentials must be unique");
      if (
        input.backendKey === input.sharedKey ||
        hash(input.backendKey) === this.adminHash ||
        hash(input.sharedKey) === this.adminHash
      )
        throw new GatewayError(400, "Use independent worker secrets");
      const invite = token();
      const expires = Date.now() + 24 * 60 * 60 * 1000;
      state.users.push({
        id: input.id,
        name: input.name,
        backendUrl: input.backendUrl,
        backendKey: input.backendKey,
        sharedHash: hash(input.sharedKey),
        disabled: false,
        claimed: input.id === "owner",
        keys: [],
        ...(input.id === "owner" ? {} : { invite: { hash: hash(invite), expires } }),
      });
      return input.id === "owner"
        ? { id: input.id }
        : { id: input.id, invitation: invite, expires };
    });
  }
  async invite(id: string) {
    return this.change((state) => {
      const user = state.users.find((user) => user.id === id && !user.disabled && !user.claimed);
      if (!user) throw new GatewayError(409, "Only an unclaimed user can receive an invitation");
      const invitation = token();
      user.invite = { hash: hash(invitation), expires: Date.now() + 24 * 60 * 60 * 1000 };
      return { id, invitation, expires: user.invite.expires };
    });
  }
  async claim(invitation: string) {
    return this.change((state) => {
      const user = state.users.find(
        (user) =>
          !user.claimed &&
          !user.disabled &&
          user.invite?.hash === hash(invitation) &&
          user.invite.expires > Date.now(),
      );
      if (!user) throw new GatewayError(401, "Invitation expired or unavailable");
      const key = token();
      const id = randomUUID();
      user.keys.push({
        id,
        label: "First agent key",
        hash: hash(key),
        created: new Date().toISOString(),
      });
      user.claimed = true;
      delete user.invite;
      return { userId: user.id, key, keyId: id };
    });
  }
  async disable(id: string, disabled: boolean) {
    if (id === "owner") throw new GatewayError(403, "The owner cannot be disabled");
    return this.change((state) => {
      const user = state.users.find((user) => user.id === id);
      if (!user) throw new GatewayError(404, "Unknown user");
      user.disabled = disabled;
      return { id, disabled };
    });
  }
  keys(principal: Principal) {
    if (principal.grantId) throw new GatewayError(403, "Use browser sign-in for account settings");
    return (this.state.users.find((user) => user.id === principal.userId)?.keys ?? []).map(
      ({ id, label, created }) => ({ id, label, created }),
    );
  }
  async createKey(principal: Principal, label: string) {
    if (principal.grantId)
      throw new GatewayError(403, "Agent connections cannot create account keys");
    return this.change((state) => {
      if (!this.active(principal)) throw new GatewayError(401, "Authentication required");
      const user = state.users.find((user) => user.id === principal.userId && !user.disabled);
      if (!user) throw new GatewayError(404, "User unavailable");
      if (user.keys.length >= 32) throw new GatewayError(409, "Revoke an unused agent key first");
      const key = token(),
        id = randomUUID();
      user.keys.push({ id, label, hash: hash(key), created: new Date().toISOString() });
      return { id, key, label };
    });
  }
  async revoke(principal: Principal, id: string) {
    if (principal.grantId)
      throw new GatewayError(403, "Agent connections cannot revoke account keys");
    return this.change((state) => {
      if (!this.active(principal)) throw new GatewayError(401, "Authentication required");
      const user = state.users.find((user) => user.id === principal.userId);
      if (!user?.keys.some((key) => key.id === id)) throw new GatewayError(404, "Unknown key");
      // Keep one recovery key; no administrator can mint a replacement for this user.
      if (user.keys.length === 1 && !principal.admin)
        throw new GatewayError(409, "Create a replacement key before revoking your last key");
      user.keys = user.keys.filter((key) => key.id !== id);
      return { id, revoked: true };
    });
  }
  private grantActive(grant: State["oauthGrants"][number]) {
    const user = this.state.users.find((entry) => entry.id === grant.userId && !entry.disabled);
    return (
      !!user &&
      grant.expires > Date.now() &&
      ((grant.parentKeyId === "bootstrap" && user.id === "owner") ||
        user.keys.some((key) => key.id === grant.parentKeyId))
    );
  }
  oauthClient(id: string) {
    return this.state.oauthClients.find((client) => client.client_id === id);
  }
  async registerOAuthClient(input: z.infer<typeof oauthClientSchema>) {
    return this.change((state) => {
      // Unused dynamic registrations are bounded and expendable. Keep clients
      // that have an active user grant so refreshing an app remains reliable.
      if (state.oauthClients.length >= 1024) {
        const unused = state.oauthClients.findIndex(
          (client) =>
            !state.oauthGrants.some(
              (grant) => grant.clientId === client.client_id && grant.expires > Date.now(),
            ),
        );
        if (unused < 0) throw new GatewayError(429, "Agent registration limit reached");
        state.oauthClients.splice(unused, 1);
      }
      const client = oauthClientSchema.parse(input);
      state.oauthClients.push(client);
      return client;
    });
  }
  private tokens(grant: State["oauthGrants"][number]) {
    const access = token(),
      refresh = token(),
      now = Date.now();
    grant.access = grant.access.filter((entry) => entry.expires > now).slice(-3);
    grant.access.push({ hash: hash(access), expires: now + 900_000 });
    grant.refreshHash = hash(refresh);
    grant.expires = now + 30 * 24 * 60 * 60_000;
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer" as const,
      expires_in: 900,
      scope: "browser",
    };
  }
  async issueOAuth(principal: Principal, clientId: string, label: string, resource: string) {
    return this.change((state) => {
      if (!this.active(principal) || principal.grantId)
        throw new GatewayError(401, "Browser sign-in expired");
      this.backend(principal);
      state.oauthGrants = state.oauthGrants.filter((entry) => entry.expires > Date.now());
      if (state.oauthGrants.filter((entry) => entry.userId === principal.userId).length >= 32)
        throw new GatewayError(409, "Disconnect an unused agent first");
      const grant: State["oauthGrants"][number] = {
        id: randomUUID(),
        userId: principal.userId,
        parentKeyId: principal.keyId,
        clientId,
        label,
        resource,
        created: new Date().toISOString(),
        expires: 0,
        access: [],
        refreshHash: hash(token()),
        previousRefreshHashes: [],
      };
      const result = this.tokens(grant);
      state.oauthGrants.push(grant);
      return result;
    });
  }
  async refreshOAuth(clientId: string, refresh: string, resource: string) {
    const candidate = hash(refresh);
    return this.change((state) => {
      const grant = state.oauthGrants.find(
        (entry) =>
          entry.clientId === clientId &&
          (entry.refreshHash === candidate || entry.previousRefreshHashes.includes(candidate)),
      );
      if (!grant || grant.resource !== resource || !this.grantActive(grant)) return undefined;
      if (grant.refreshHash !== candidate) {
        state.oauthGrants = state.oauthGrants.filter((entry) => entry.id !== grant.id);
        return undefined;
      }
      grant.previousRefreshHashes = [...grant.previousRefreshHashes, candidate].slice(-8);
      return this.tokens(grant);
    });
  }
  oauthConnections(principal: Principal) {
    if (principal.grantId) throw new GatewayError(403, "Use browser sign-in for account settings");
    return this.state.oauthGrants
      .filter((grant) => grant.userId === principal.userId && this.grantActive(grant))
      .map(({ id, label, created }) => ({ id, label, created }));
  }
  async revokeOAuth(principal: Principal, id: string) {
    if (principal.grantId) throw new GatewayError(403, "Use browser sign-in for account settings");
    return this.change((state) => {
      if (!this.active(principal)) throw new GatewayError(401, "Authentication required");
      state.oauthGrants = state.oauthGrants.filter(
        (grant) => grant.userId !== principal.userId || grant.id !== id,
      );
      return { disconnected: true };
    });
  }
  async revokeOAuthToken(clientId: string, value: string) {
    const candidate = hash(value);
    return this.change((state) => {
      state.oauthGrants = state.oauthGrants.filter(
        (grant) =>
          grant.clientId !== clientId ||
          !(
            grant.refreshHash === candidate ||
            grant.previousRefreshHashes.includes(candidate) ||
            grant.access.some((entry) => entry.hash === candidate)
          ),
      );
    });
  }
  sharedForWorker(value?: string): SharedSnapshot | undefined {
    if (!value || value.length > 512) return;
    const candidate = hash(value);
    const user = this.state.users.find((user) => !user.disabled && user.sharedHash === candidate);
    if (user) {
      const snapshot = structuredClone(this.state.shared);
      for (const name of Object.keys(snapshot.credentials))
        if (!this.permittedCredential(name, user.id)) delete snapshot.credentials[name];
      return snapshot;
    }
  }
  principalActiveForWorker(value: string | undefined, principal: Principal) {
    if (!value || value.length > 512) return false;
    const candidate = hash(value);
    const user = this.state.users.find(
      (entry) => !entry.disabled && entry.sharedHash === candidate,
    );
    return !!user && user.id === principal.userId && this.active(principal);
  }
  libraryActorForWorker(value?: string, principal?: Principal) {
    if (!value || value.length > 512) return;
    const candidate = hash(value);
    const user = this.state.users.find(
      (entry) => !entry.disabled && entry.sharedHash === candidate,
    );
    if (!user || (principal && (principal.userId !== user.id || !this.active(principal)))) return;
    return {
      ...organizationMember(user.id, this.organization),
      ...(principal ? { principal } : {}),
    };
  }
  private permittedCredential(name: string, userId: string) {
    // Historical unscoped entries retain their company-wide access. New entries
    // receive an explicit owner grant; narrowing an old entry is deliberate.
    const grant = this.state.credentialGrants[name];
    return !grant || grant.includes(userId);
  }
  sharedMetadata(principal: Principal) {
    if (!this.active(principal)) throw new GatewayError(401, "Authentication required");
    return {
      credentials: Object.entries(this.state.shared.credentials)
        .filter(([name]) => principal.admin || this.permittedCredential(name, principal.userId))
        .map(([name, fields]) => ({
          name,
          fields: Object.keys(fields),
          ...(principal.admin ? { allowedUsers: this.state.credentialGrants[name] ?? null } : {}),
        })),
      sites: structuredClone(this.state.shared.sites),
    };
  }
  async putSharedGrants(name: string, input: unknown) {
    storeName.parse(name);
    const { allowedUsers } = z
      .object({ allowedUsers: z.array(storeName).min(1).max(100) })
      .strict()
      .parse(input);
    return this.change((state) => {
      if (!Object.hasOwn(state.shared.credentials, name))
        throw new GatewayError(404, "Unknown shared account");
      if (allowedUsers.some((id) => id !== "owner" && !state.users.some((user) => user.id === id)))
        throw new GatewayError(400, "Select registered users for this account");
      state.credentialGrants[name] = [...new Set(allowedUsers)];
      return { name, allowedUsers: state.credentialGrants[name] };
    });
  }
  async putShared(kind: "vault" | "sites", name: string, value: unknown) {
    const parsed = kind === "vault" ? credentialFields.parse(value) : sharedSite.parse(value);
    if (kind === "vault") storeName.parse(name);
    else if (new URL((parsed as z.infer<typeof sharedSite>).url).hostname !== name)
      throw new GatewayError(400, "The shared site URL must match its host");
    return this.change((state) => {
      const target = kind === "vault" ? state.shared.credentials : state.shared.sites;
      if (Object.keys(target).length >= 100 && !Object.hasOwn(target, name))
        throw new GatewayError(409, "Shared store limit reached");
      if (kind === "vault") {
        if (!Object.hasOwn(state.shared.credentials, name))
          state.credentialGrants[name] = ["owner"];
        state.shared.credentials[name] = parsed as Record<string, string>;
      } else {
        const site = parsed as z.infer<typeof sharedSite>;
        if (
          Object.entries(state.shared.sites).some(
            ([host, row]) => host !== name && row.site === site.site,
          )
        )
          throw new GatewayError(409, "Shared site name already belongs to another host");
        state.shared.sites[name] = site;
      }
      return { name, saved: true };
    });
  }
  async deleteShared(kind: "vault" | "sites", name: string) {
    return this.change((state) => {
      delete (kind === "vault" ? state.shared.credentials : state.shared.sites)[name];
      if (kind === "vault") delete state.credentialGrants[name];
      return { name, deleted: true };
    });
  }
}
