// Provisions only Toolstack's dedicated storage. Dry-run is the default.
// Do not use this to change PMS resources, rotate existing unknown keys, or
// deploy/reconfigure the owner's running browser worker. Secrets stay in a 0600 file.
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { parseArgs, parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  GetBucketAclCommand,
  GetBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import {
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "global-env": {
      type: "string",
      default: path.join(homedir(), "nosync.nosync/-env/global.env"),
    },
    output: { type: "string", default: path.join(homedir(), "nosync.nosync/-env/toolstack.env") },
  },
});
const projectId = "bbbe0a8e-81f7-41b9-9d64-76a38ad7d8fb",
  environmentId = "1ff52f6b-2c4d-4a5d-835d-fe90506420d2";
const bucket = "toolstack-content-bbbe0a8e",
  user = "toolstack-library",
  serviceName = "Toolstack Postgres";
const image =
  "ghcr.io/railwayapp-templates/postgres-ssl@sha256:4fc833b43d2aaf6ecc9b18615f5533602b723a32d0e2efe2dae8ca0f7217c863";
console.log(
  JSON.stringify(
    {
      apply: values.apply,
      project: "vigilant-peace",
      databaseService: serviceName,
      postgresImage: image,
      volumeMount: "/var/lib/postgresql/data",
      wasabiBucket: bucket,
      wasabiIamUser: user,
      output: values.output,
      existingBrowserWorker: "unchanged",
    },
    null,
    2,
  ),
);
if (!values.apply) process.exit(0);
const global = parseEnv(await readFile(values["global-env"], "utf8"));
let state = {};
try {
  const info = await lstat(values.output);
  if (info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("Provisioning output must be a private regular file");
  state = parseEnv(await readFile(values.output, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const persist = async () => {
  await mkdir(path.dirname(values.output), { recursive: true, mode: 0o700 });
  const tmp = values.output + ".tmp";
  await writeFile(
    tmp,
    Object.entries(state)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await rename(tmp, values.output);
};
async function gql(query, variables = {}) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      authorization: `Bearer ${global.RAILWAY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors)
    throw new Error("Railway provisioning request failed; secret-bearing response suppressed");
  return result.data;
}
const credentials = {
  accessKeyId: global.WASABI_ACCESS_KEY,
  secretAccessKey: global.WASABI_SECRET_KEY,
};
const region = global.WASABI_REGION || "us-east-1";
const s3 = new S3Client({
  region,
  endpoint:
    region === "us-east-1" ? "https://s3.wasabisys.com" : `https://s3.${region}.wasabisys.com`,
  forcePathStyle: true,
  credentials,
  maxAttempts: 1,
});
const iam = new IAMClient({
  region: "us-east-1",
  endpoint: "https://iam.wasabisys.com",
  credentials,
  maxAttempts: 1,
});
const send = (client, command) => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
try {
  try {
    await send(s3, new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404)
      throw new Error(`Wasabi bucket inspection failed (${error.name})`);
    await send(
      s3,
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region } }),
      }),
    );
    console.log("Created private Toolstack bucket");
  }
  const acl = await send(s3, new GetBucketAclCommand({ Bucket: bucket }));
  if (acl.Grants?.some((grant) => grant.Grantee?.URI))
    throw new Error("Refusing a bucket with group access grants");
  try {
    const policy = await send(s3, new GetBucketPolicyCommand({ Bucket: bucket }));
    if (policy.Policy)
      throw new Error("Existing bucket policy requires review before Toolstack uses it");
  } catch (error) {
    if (!["NoSuchBucketPolicy", "NoSuchBucketPolicyException"].includes(error.name)) throw error;
  }
  try {
    await send(iam, new GetUserCommand({ UserName: user }));
  } catch (error) {
    if (error.name !== "NoSuchEntityException") throw error;
    await send(iam, new CreateUserCommand({ UserName: user }));
    console.log("Created Toolstack storage identity");
  }
  await send(
    iam,
    new PutUserPolicyCommand({
      UserName: user,
      PolicyName: "toolstack-content-only",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:ListBucket", "s3:GetBucketLocation"],
            Resource: `arn:aws:s3:::${bucket}`,
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: `arn:aws:s3:::${bucket}/packages/*`,
          },
        ],
      }),
    }),
  );
  if (!state.TOOLSTACK_WASABI_ACCESS_KEY) {
    const keys = await send(iam, new ListAccessKeysCommand({ UserName: user }));
    if (keys.AccessKeyMetadata?.length)
      throw new Error(
        "An existing Toolstack storage key cannot be recovered; refusing to rotate it",
      );
    const result = await send(iam, new CreateAccessKeyCommand({ UserName: user }));
    state.TOOLSTACK_WASABI_ACCESS_KEY = result.AccessKey.AccessKeyId;
    state.TOOLSTACK_WASABI_SECRET_KEY = result.AccessKey.SecretAccessKey;
  }
  Object.assign(state, {
    TOOLSTACK_WASABI_BUCKET: bucket,
    TOOLSTACK_WASABI_REGION: region,
    TOOLSTACK_CONTENT_KEY: state.TOOLSTACK_CONTENT_KEY || randomBytes(32).toString("hex"),
    TOOLSTACK_DATABASE_PASSWORD:
      state.TOOLSTACK_DATABASE_PASSWORD || randomBytes(32).toString("hex"),
  });
  await persist();
  const project = await gql("query($id:String!){project(id:$id){services{edges{node{id name}}}}}", {
    id: projectId,
  });
  let service = project.project.services.edges
    .map((edge) => edge.node)
    .find((item) => item.name === serviceName);
  if (service && service.id !== state.TOOLSTACK_POSTGRES_SERVICE_ID)
    throw new Error(
      "Existing database service has no matching local provisioning state; refusing changes",
    );
  if (!service) {
    const variables = {
      POSTGRES_DB: "toolstack",
      POSTGRES_USER: "toolstack",
      POSTGRES_PASSWORD: state.TOOLSTACK_DATABASE_PASSWORD,
      PGDATA: "/var/lib/postgresql/data/pgdata",
      LOG_TO_STDOUT: "true",
    };
    const created = await gql(
      "mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id name}}",
      { input: { projectId, environmentId, name: serviceName, source: { image }, variables } },
    );
    service = created.serviceCreate;
    state.TOOLSTACK_POSTGRES_SERVICE_ID = service.id;
    await persist();
    console.log("Created dedicated Toolstack Postgres service");
  }
  if (!state.TOOLSTACK_POSTGRES_VOLUME_ID) {
    const created = await gql(
      "mutation($input:VolumeCreateInput!){volumeCreate(input:$input){id}}",
      {
        input: {
          projectId,
          environmentId,
          serviceId: service.id,
          mountPath: "/var/lib/postgresql/data",
        },
      },
    );
    state.TOOLSTACK_POSTGRES_VOLUME_ID = created.volumeCreate.id;
    await persist();
    console.log("Attached the database's persistent volume");
  }
  await gql(
    "mutation($s:String!,$e:String!){serviceInstanceDeploy(serviceId:$s,environmentId:$e,latestCommit:true)}",
    { s: service.id, e: environmentId },
  );
  // Private DNS is assigned to the service, never inferred from its display name.
  const vars = await gql(
    "query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
    { p: projectId, e: environmentId, s: service.id },
  );
  const host = vars.variables.RAILWAY_PRIVATE_DOMAIN;
  if (host)
    state.TOOLSTACK_DATABASE_URL = `postgresql://toolstack:${state.TOOLSTACK_DATABASE_PASSWORD}@${host}:5432/toolstack?sslmode=require`;
  await persist();
  console.log(
    JSON.stringify(
      {
        provisioned: true,
        bucket,
        service: serviceName,
        privateDatabaseUrlConfigured: !!state.TOOLSTACK_DATABASE_URL,
        credentialsFile: values.output,
        secretValuesPrinted: false,
        existingBrowserWorker: "unchanged",
      },
      null,
      2,
    ),
  );
} catch (error) {
  // AWS errors can carry request context. Print the name only, never serialize it.
  console.error(error.name === "Error" ? error.message : `Provisioning failed: ${error.name}`);
  process.exitCode = 1;
} finally {
  s3.destroy();
  iam.destroy();
}
