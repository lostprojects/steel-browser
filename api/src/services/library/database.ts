// Fixed, additive Toolstack migrations. Never point this connection at PMS.
// Request values use tagged parameters; unsafe() is restricted to this static DDL.
import postgres from "postgres";
import { currentOrganization, membershipId, type Organization } from "../organization.js";

export const migration = `
CREATE TABLE IF NOT EXISTS toolstack_library_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS toolstack_packages (
 id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, description text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('skill','toolkit','workflow')), latest integer NOT NULL CHECK(latest > 0),
 visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','assigned','global')),
 assigned_to jsonb NOT NULL DEFAULT '[]', archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toolstack_packages_owner ON toolstack_packages(owner_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS toolstack_packages_visible ON toolstack_packages(visibility,updated_at DESC,id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS toolstack_packages_assignments ON toolstack_packages USING gin(assigned_to);
CREATE TABLE IF NOT EXISTS toolstack_package_versions (
 package_id uuid NOT NULL REFERENCES toolstack_packages(id), version integer NOT NULL,
 owner_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL, operation text NOT NULL,
 title text NOT NULL, description text NOT NULL, kind text NOT NULL, instructions text NOT NULL,
 runtime jsonb, file_ids jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(package_id,version), UNIQUE(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS toolstack_content_files (
 id uuid PRIMARY KEY, package_id uuid NOT NULL REFERENCES toolstack_packages(id),
 owner_id text NOT NULL, object_key text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL,
 media_type text NOT NULL, bytes integer NOT NULL CHECK(bytes >= 0), sha256 text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','ready')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toolstack_content_files_package ON toolstack_content_files(package_id,state);
CREATE INDEX IF NOT EXISTS toolstack_content_files_owner ON toolstack_content_files(owner_id);
INSERT INTO toolstack_library_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`;

export function libraryDatabase(url: string) {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("Toolstack requires a Postgres URL");
  return postgres(url, {
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: "toolstack-library", statement_timeout: 15_000 },
    onnotice: () => {},
  });
}
export type LibraryDatabase = ReturnType<typeof libraryDatabase>;
export async function migrateLibrary(
  sql: LibraryDatabase,
  organization: Organization = currentOrganization(),
) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(761933004621)`;
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS toolstack_organizations (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), id uuid NOT NULL UNIQUE,
      name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS toolstack_memberships (
      org_id uuid NOT NULL REFERENCES toolstack_organizations(id),id uuid NOT NULL,user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,id),UNIQUE(org_id,user_id));`);
    await tx`INSERT INTO toolstack_organizations(id,name) VALUES(${organization.id},${organization.name}) ON CONFLICT(singleton) DO NOTHING`;
    const [bound] = await tx`SELECT id FROM toolstack_organizations`;
    if (bound?.id !== organization.id)
      throw new Error("This database belongs to another organization; startup refused");
    await tx`UPDATE toolstack_organizations SET name=${organization.name} WHERE id=${organization.id}`;
    await tx.unsafe(migration);
    if ((await tx`SELECT version FROM toolstack_library_schema WHERE version=2`).length) return;
    await tx.unsafe(`
      ALTER TABLE toolstack_packages ADD COLUMN IF NOT EXISTS org_id uuid;
      ALTER TABLE toolstack_packages ADD COLUMN IF NOT EXISTS owner_membership_id uuid;
      ALTER TABLE toolstack_packages ADD COLUMN IF NOT EXISTS assigned_memberships jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE toolstack_package_versions ADD COLUMN IF NOT EXISTS org_id uuid;
      ALTER TABLE toolstack_package_versions ADD COLUMN IF NOT EXISTS owner_membership_id uuid;
      ALTER TABLE toolstack_content_files ADD COLUMN IF NOT EXISTS org_id uuid;
      ALTER TABLE toolstack_content_files ADD COLUMN IF NOT EXISTS owner_membership_id uuid;`);
    const [foreign] =
      await tx`SELECT id FROM toolstack_packages WHERE org_id IS NOT NULL AND org_id<>${organization.id} LIMIT 1`;
    if (foreign) throw new Error("Mixed organization records found; migration refused");
    const members = await tx`SELECT DISTINCT owner_id AS user_id FROM toolstack_packages
      UNION SELECT DISTINCT jsonb_array_elements_text(assigned_to) AS user_id FROM toolstack_packages
      UNION SELECT 'owner' AS user_id`;
    for (const member of members) {
      const id = membershipId(organization.id, member.user_id);
      await tx`INSERT INTO toolstack_memberships(org_id,id,user_id) VALUES(${organization.id},${id},${member.user_id}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE toolstack_packages SET org_id=${organization.id},owner_membership_id=${id} WHERE owner_id=${member.user_id} AND org_id IS NULL`;
    }
    const packages =
      await tx`SELECT id,assigned_to FROM toolstack_packages WHERE org_id=${organization.id}`;
    for (const p of packages)
      await tx`UPDATE toolstack_packages SET assigned_memberships=${tx.json(p.assigned_to.map((user: string) => membershipId(organization.id, user)))} WHERE id=${p.id}`;
    await tx`UPDATE toolstack_package_versions v SET org_id=p.org_id,owner_membership_id=p.owner_membership_id FROM toolstack_packages p WHERE v.package_id=p.id AND v.org_id IS NULL`;
    await tx`UPDATE toolstack_content_files f SET org_id=p.org_id,owner_membership_id=p.owner_membership_id FROM toolstack_packages p WHERE f.package_id=p.id AND f.org_id IS NULL`;
    await tx.unsafe(`
      ALTER TABLE toolstack_packages ALTER COLUMN org_id SET NOT NULL;
      ALTER TABLE toolstack_packages ALTER COLUMN owner_membership_id SET NOT NULL;
      ALTER TABLE toolstack_package_versions ALTER COLUMN org_id SET NOT NULL;
      ALTER TABLE toolstack_package_versions ALTER COLUMN owner_membership_id SET NOT NULL;
      ALTER TABLE toolstack_content_files ALTER COLUMN org_id SET NOT NULL;
      ALTER TABLE toolstack_content_files ALTER COLUMN owner_membership_id SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS toolstack_packages_org_id ON toolstack_packages(org_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS toolstack_packages_org_owner ON toolstack_packages(org_id,id,owner_membership_id);
      CREATE INDEX IF NOT EXISTS toolstack_packages_membership ON toolstack_packages(org_id,owner_membership_id,updated_at DESC,id);
      DO $$ BEGIN
        ALTER TABLE toolstack_packages ADD CONSTRAINT toolstack_packages_membership_fk FOREIGN KEY(org_id,owner_membership_id) REFERENCES toolstack_memberships(org_id,id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE toolstack_package_versions ADD CONSTRAINT toolstack_versions_org_owner_fk FOREIGN KEY(org_id,package_id,owner_membership_id) REFERENCES toolstack_packages(org_id,id,owner_membership_id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE toolstack_content_files ADD CONSTRAINT toolstack_files_org_owner_fk FOREIGN KEY(org_id,package_id,owner_membership_id) REFERENCES toolstack_packages(org_id,id,owner_membership_id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      INSERT INTO toolstack_library_schema(version) VALUES(2) ON CONFLICT DO NOTHING;`);
  });
}
