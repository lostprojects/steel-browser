import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PublicError } from "../../utils/public-error.js";
import { storeName } from "../shared-store.js";
import {
  archivePackage,
  createPackage,
  listPackages,
  maxFileBytes,
  packageId,
  sharePackage,
  updatePackage,
  uploadFile,
  type LibraryActor,
  type LibraryCommand,
  type LibraryService,
} from "./contracts.js";
import { type LibraryDatabase, migrateLibrary } from "./database.js";
import type { LibraryObjects } from "./objects.js";
import {
  assertOrganizationMember,
  currentOrganization,
  membershipId,
  type Organization,
} from "../organization.js";

const unavailable = () => new PublicError("content_unavailable", "Content is unavailable", 404);
const conflict = () =>
  new PublicError(
    "content_changed",
    "This package changed. Reload it before saving your changes.",
    409,
  );
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileFields = (row: any) => ({
  id: row.id,
  name: row.name,
  role: row.role,
  mediaType: row.media_type,
  bytes: row.bytes,
  sha256: row.sha256,
});

export class ContentLibrary implements LibraryService {
  private activeFiles = 0;
  private registeredMembers = new Set<string>();
  readonly ready: Promise<void>;
  constructor(
    readonly sql: LibraryDatabase,
    private readonly objects: LibraryObjects,
    readonly organization: Organization = currentOrganization(),
  ) {
    this.ready = migrateLibrary(sql, organization);
    void this.ready.catch(() => undefined);
  }
  async close() {
    await this.sql.end({ timeout: 5 });
    this.objects.close();
  }
  private visible(actor: LibraryActor) {
    return this
      .sql`(p.org_id=${actor.orgId} AND (p.owner_membership_id=${actor.membershipId} OR p.visibility='global' OR (p.visibility='assigned' AND p.assigned_memberships ? ${actor.membershipId})))`;
  }
  private async allowed(id: string, actor: LibraryActor, owner = false) {
    const rows = await this.sql`SELECT p.* FROM toolstack_packages p WHERE p.id=${id}
      AND p.org_id=${actor.orgId}
      AND ${owner ? this.sql`p.owner_membership_id=${actor.membershipId}` : this.visible(actor)}
      AND (NOT p.archived OR p.owner_membership_id=${actor.membershipId})`;
    if (!rows[0]) throw unavailable();
    return rows[0];
  }
  private summary(p: any, user: string) {
    return {
      id: p.id,
      orgId: p.org_id,
      ownerMembershipId: p.owner_membership_id,
      owner: p.owner_id,
      title: p.title,
      description: p.description,
      kind: p.kind,
      version: p.latest,
      visibility: p.visibility,
      archived: p.archived,
      ...(p.owner_id === user ? { assignedTo: p.assigned_to } : {}),
      canEdit: p.owner_id === user,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }
  private async read(id: string, actor: LibraryActor, version?: number) {
    const p = await this.allowed(id, actor);
    if (version !== undefined && version !== p.latest && p.owner_id !== actor.userId)
      throw unavailable();
    const [v] = await this
      .sql`SELECT * FROM toolstack_package_versions WHERE package_id=${id} AND version=${version ?? p.latest}`;
    if (!v) throw unavailable();
    const files = await this
      .sql`SELECT * FROM toolstack_content_files WHERE package_id=${id} AND state='ready'
      AND ${this.sql.json(v.file_ids)}::jsonb ? id::text ORDER BY name,id`;
    return {
      ...this.summary(p, actor.userId),
      version: v.version,
      latestVersion: p.latest,
      title: v.title,
      description: v.description,
      kind: v.kind,
      instructions: v.instructions,
      runtime: v.runtime,
      files: files.map(fileFields),
    };
  }
  private async replay(tx: any, actor: LibraryActor, request: string, fingerprint: string) {
    const [v] =
      await tx`SELECT package_id,version,request_hash FROM toolstack_package_versions WHERE org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} AND request_id=${request}`;
    if (v && v.request_hash !== fingerprint)
      throw new PublicError(
        "idempotency_conflict",
        "This request ID was used with different content",
        409,
      );
    return v;
  }
  private async mutate(
    actor: LibraryActor,
    id: string | undefined,
    action: string,
    input: any,
    fingerprint: string,
    file?: { id: string },
  ) {
    return this.sql.begin(async (tx) => {
      // Serialize a person's quota checks and retry records. No network work is
      // performed while holding this transaction lock.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.userId},86107))`;
      const replay = await this.replay(tx, actor, input.requestId, fingerprint);
      if (replay)
        return { id: replay.package_id as string, version: replay.version as number, replay: true };
      let p: any, previous: any;
      if (id) {
        [p] =
          await tx`SELECT * FROM toolstack_packages WHERE id=${id} AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} FOR UPDATE`;
        if (!p) throw unavailable();
        if (p.latest !== input.expectedVersion) throw conflict();
        [previous] =
          await tx`SELECT * FROM toolstack_package_versions WHERE package_id=${id} AND version=${p.latest}`;
      } else {
        const [count] =
          await tx`SELECT count(*)::integer AS count FROM toolstack_packages WHERE org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId}`;
        if (count.count >= 1000)
          throw new PublicError(
            "content_limit",
            "The content library has reached its package limit",
            429,
          );
        id = randomUUID();
        [p] =
          await tx`INSERT INTO toolstack_packages(org_id,owner_membership_id,id,owner_id,title,description,kind,latest)
          VALUES(${actor.orgId},${actor.membershipId},${id},${actor.userId},${input.title},${input.description},${input.kind},1) RETURNING *`;
      }
      const next = action === "create" || action === "update" ? input : previous;
      const version = previous ? p.latest + 1 : 1;
      if (version > 10_000)
        throw new PublicError("content_limit", "The package has reached its version limit", 429);
      const fileIds: string[] = action === "update" ? input.files : (previous?.file_ids ?? []);
      if (file) fileIds.push(file.id);
      if (fileIds.length > 100 || new Set(fileIds).size !== fileIds.length)
        throw new PublicError("invalid_content", "Use at most 100 distinct files per version", 400);
      const [valid] =
        await tx`SELECT count(*)::integer AS count FROM toolstack_content_files WHERE package_id=${id}
        AND (state='ready' OR id=${file?.id ?? null}) AND ${tx.json(fileIds)}::jsonb ? id::text`;
      if (valid.count !== fileIds.length)
        throw new PublicError(
          "invalid_content",
          "A selected file is unavailable in this package",
          400,
        );
      await tx`INSERT INTO toolstack_package_versions(org_id,owner_membership_id,package_id,version,owner_id,request_id,request_hash,operation,title,description,kind,instructions,runtime,file_ids)
        VALUES(${actor.orgId},${actor.membershipId},${id},${version},${actor.userId},${input.requestId},${fingerprint},${action},${next.title},${next.description},${next.kind},${next.instructions},${next.runtime ? tx.json(next.runtime) : null},${tx.json(fileIds)})`;
      await tx`UPDATE toolstack_packages SET latest=${version},title=${next.title},description=${next.description},kind=${next.kind},updated_at=now(),
        visibility=${action === "share" ? input.visibility : p.visibility},
        assigned_to=${tx.json(action === "share" ? [...new Set(input.assignedTo)] : p.assigned_to)},
        assigned_memberships=${tx.json(action === "share" ? [...new Set(input.assignedTo as string[])].map((user) => membershipId(actor.orgId, user)) : p.assigned_memberships)},
        archived=${action === "archive" ? input.archived : p.archived} WHERE id=${id}`;
      if (file) await tx`UPDATE toolstack_content_files SET state='ready' WHERE id=${file.id}`;
      return { id: id!, version, replay: false };
    });
  }
  async call(actor: LibraryActor, command: LibraryCommand): Promise<any> {
    assertOrganizationMember(actor, this.organization);
    if (
      actor.principal &&
      (actor.principal.orgId !== actor.orgId ||
        actor.principal.membershipId !== actor.membershipId ||
        actor.principal.userId !== actor.userId)
    )
      throw unavailable();
    if (!["upload", "file"].includes(command.action)) return this.perform(actor, command);
    if (this.activeFiles >= 2)
      throw new PublicError(
        "library_busy",
        "File storage is busy. Retry with the same request ID.",
        429,
      );
    this.activeFiles++;
    try {
      return await this.perform(actor, command);
    } finally {
      this.activeFiles--;
    }
  }
  private async perform(actor: LibraryActor, command: LibraryCommand): Promise<any> {
    await this.ready;
    storeName.parse(actor.userId);
    if (!this.registeredMembers.has(actor.membershipId)) {
      await this
        .sql`INSERT INTO toolstack_memberships(org_id,id,user_id) VALUES(${actor.orgId},${actor.membershipId},${actor.userId}) ON CONFLICT DO NOTHING`;
      const [member] = await this
        .sql`SELECT user_id FROM toolstack_memberships WHERE org_id=${actor.orgId} AND id=${actor.membershipId}`;
      if (member?.user_id !== actor.userId) throw unavailable();
      if (this.registeredMembers.size < 1000) this.registeredMembers.add(actor.membershipId);
    }
    const id = command.id === undefined ? undefined : packageId.parse(command.id);
    if (command.action === "list") {
      const input = listPackages.parse(command.input ?? {});
      const rows = await this
        .sql`SELECT p.*,count(*) OVER()::integer AS total FROM toolstack_packages p WHERE
        p.org_id=${actor.orgId} AND ${input.scope === "available" ? this.visible(actor) : this.sql`p.owner_membership_id=${actor.membershipId}`}
        AND p.archived=${input.scope === "archived"} AND (p.title ILIKE ${`%${input.query}%`} OR p.description ILIKE ${`%${input.query}%`})
        ORDER BY p.updated_at DESC,p.id LIMIT ${input.limit} OFFSET ${input.offset}`;
      const total = rows[0]?.total ?? 0;
      return {
        userId: actor.userId,
        organization: this.organization,
        membershipId: actor.membershipId,
        packages: rows.map((p) => this.summary(p, actor.userId)),
        total,
        nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null,
      };
    }
    if (command.action === "get")
      return this.read(
        packageId.parse(id),
        actor,
        command.version === undefined
          ? undefined
          : z.number().int().positive().parse(command.version),
      );
    if (command.action === "history") {
      await this.allowed(packageId.parse(id), actor, true);
      return {
        versions: await this
          .sql`SELECT version,operation,created_at AS "createdAt" FROM toolstack_package_versions WHERE package_id=${id!} ORDER BY version DESC LIMIT 100`,
      };
    }
    if (command.action === "file" || command.action === "file_info") {
      const fileId = packageId.parse((command.input as any)?.file);
      const p = await this.allowed(packageId.parse(id), actor);
      const [file] = await this
        .sql`SELECT f.* FROM toolstack_content_files f WHERE f.id=${fileId} AND f.package_id=${id!} AND f.state='ready'
        AND (${p.owner_id === actor.userId} OR EXISTS(SELECT 1 FROM toolstack_package_versions v WHERE v.package_id=f.package_id AND v.version=${p.latest} AND v.file_ids ? f.id::text))`;
      if (!file) throw unavailable();
      if (command.action === "file_info") return fileFields(file);
      const data = await this.objects.get(file.object_key);
      if (
        data.length !== file.bytes ||
        createHash("sha256").update(data).digest("hex") !== file.sha256
      )
        throw new PublicError(
          "content_integrity",
          "Stored file did not pass its integrity check",
          502,
        );
      // Recheck publication after a potentially slow object read.
      await this.call(actor, { action: "file_info", id, input: { file: fileId } });
      return { ...fileFields(file), base64: data.toString("base64") };
    }
    if (command.action === "upload") {
      const { base64, ...metadata } = z
        .object({ ...uploadFile.shape, base64: z.string().max(Math.ceil(maxFileBytes / 3) * 4) })
        .strict()
        .parse(command.input);
      const data = Buffer.from(base64, "base64");
      if (data.toString("base64") !== base64)
        throw new PublicError("invalid_content", "Invalid file encoding", 400);
      if (!data.length || data.length > maxFileBytes)
        throw new PublicError("content_limit", "Files must be between 1 byte and 16 MiB", 413);
      await this.allowed(packageId.parse(id), actor, true);
      const fingerprint = hash([
        "upload",
        id,
        metadata,
        createHash("sha256").update(data).digest("hex"),
      ]);
      const old = await this.replay(this.sql, actor, metadata.requestId, fingerprint);
      if (old) return this.read(old.package_id, actor, old.version);
      const fileId = randomUUID(),
        objectKey = `packages/${actor.orgId}/${id}/${fileId}`;
      await this.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.userId},86107))`;
        const [p] =
          await tx`SELECT latest,archived FROM toolstack_packages WHERE id=${id!} AND org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId} FOR UPDATE`;
        if (!p || p.archived) throw unavailable();
        if (p.latest !== metadata.expectedVersion) throw conflict();
        const [quota] =
          await tx`SELECT COALESCE(sum(bytes),0)::bigint AS bytes,count(*)::integer AS count FROM toolstack_content_files WHERE org_id=${actor.orgId} AND owner_membership_id=${actor.membershipId}`;
        if (Number(quota.bytes) + data.length > 2 * 1024 ** 3 || quota.count >= 2000)
          throw new PublicError(
            "content_limit",
            "Your content file storage limit has been reached",
            429,
          );
        await tx`INSERT INTO toolstack_content_files(org_id,owner_membership_id,id,package_id,owner_id,object_key,name,role,media_type,bytes,sha256,state)
          VALUES(${actor.orgId},${actor.membershipId},${fileId},${id!},${actor.userId},${objectKey},${metadata.name},${metadata.role},${metadata.mediaType},${data.length},${createHash("sha256").update(data).digest("hex")},'pending')`;
      });
      let publishing = false;
      try {
        await this.objects.put(objectKey, data);
        publishing = true;
        const result = await this.mutate(actor, id, "upload", metadata, fingerprint, {
          id: fileId,
        });
        if (result.replay) await this.discardPending(fileId, objectKey);
        return this.read(result.id, actor, result.version);
      } catch (error) {
        // An ambiguous database commit must not delete a published object's bytes.
        if (!publishing || error instanceof PublicError)
          await this.discardPending(fileId, objectKey).catch(() => undefined);
        throw error;
      }
    }
    const schema = {
      create: createPackage,
      update: updatePackage,
      share: sharePackage,
      archive: archivePackage,
    }[command.action];
    if (!schema) throw new PublicError("invalid_request", "Unknown library operation", 400);
    const input = schema.parse(command.input);
    if (command.action !== "create") await this.allowed(packageId.parse(id), actor, true);
    const result = await this.mutate(
      actor,
      id,
      command.action,
      input,
      hash([command.action, id ?? null, input]),
    );
    return this.read(result.id, actor, result.version);
  }
  private async discardPending(id: string, key: string) {
    const [row] = await this.sql`SELECT state FROM toolstack_content_files WHERE id=${id}`;
    if (row?.state !== "pending") return;
    await this.objects.remove(key);
    await this.sql`DELETE FROM toolstack_content_files WHERE id=${id} AND state='pending'`;
  }
  async prunePending() {
    await this.ready;
    return this.sql.begin(async (tx) => {
      const rows = await tx`SELECT id,object_key FROM toolstack_content_files
        WHERE state='pending' AND created_at < now() - interval '24 hours'
        ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        await this.objects.remove(row.object_key);
        await tx`DELETE FROM toolstack_content_files WHERE id=${row.id} AND state='pending'`;
      }
      return { removed: rows.length, objects: rows.map((row) => row.object_key) };
    });
  }
}
