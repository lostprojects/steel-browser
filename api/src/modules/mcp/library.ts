import { z } from "zod";
import type { Toolkit } from "../../services/toolkits/registry.js";
import {
  archivePackage,
  createPackage,
  libraryActor,
  listPackages,
  packageId,
  sharePackage,
  updatePackage,
  uploadFile,
  type LibraryService,
} from "../../services/library/contracts.js";
import { callLibrary } from "../../services/library/service.js";
import { assertAgentCurrent } from "../../services/agent-access.js";
import { textResult } from "./tools.js";
import { getUrl } from "../../utils/url.js";

export function libraryToolkit(service: () => LibraryService | undefined): Toolkit {
  const definitions = [
    {
      name: "library_list",
      action: "list",
      input: listPackages,
      read: true,
      description:
        "Find your skills and tooling, including content assigned to you or published globally. Uploaded scripts are stored content; they do not execute automatically.",
    },
    {
      name: "library_get",
      action: "get",
      input: z.object({ id: packageId, version: z.number().int().positive().optional() }).strict(),
      read: true,
      description:
        "Read an available package's instructions, runtime requirements and exact file checksums. Historical versions are owner-only.",
    },
    {
      name: "library_create",
      action: "create",
      input: createPackage,
      read: false,
      description:
        "Create private content owned by the authenticated person. Reuse requestId after an interrupted response.",
    },
    {
      name: "library_update",
      action: "update",
      input: updatePackage.extend({ id: packageId }),
      read: false,
      description:
        "Save a new immutable package version. Supply expectedVersion and the exact retained file IDs; conflicts require reloading.",
    },
    {
      name: "library_share",
      action: "share",
      input: sharePackage.safeExtend({ id: packageId }),
      read: false,
      description:
        "Owner-only private, assigned or global visibility. Content sharing does not share credentials. Reuse requestId on retry.",
    },
    {
      name: "library_archive",
      action: "archive",
      input: archivePackage.extend({ id: packageId }),
      read: false,
      description:
        "Owner-only archive or restore. Archiving withdraws shared access while retaining files and versions.",
    },
    {
      name: "library_upload",
      action: "upload",
      input: uploadFile.extend({ id: packageId, base64: z.string().max(1_400_000) }),
      read: false,
      description:
        "Attach a small base64-encoded script or reference to an owned package. Large files use the app upload. A new package version records its immutable file ID and checksum.",
    },
    {
      name: "library_file",
      action: "file_info",
      input: z.object({ id: packageId, file: packageId }).strict(),
      read: true,
      description:
        "Get an authenticated download link and SHA-256 for a permitted package file. The link requires your Toolstack connection.",
    },
  ] as const;
  return {
    id: "library",
    name: "Content library",
    version: "1.0.0",
    description: "Your owned skills, tooling and reference files",
    authentication: "Uses the authenticated person's content ownership and sharing grants.",
    tools: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      input: definition.input,
      annotations: { readOnlyHint: definition.read, openWorldHint: false },
      execute: async (args, context) => {
        await assertAgentCurrent(context.agent);
        const { id, version, ...input } = args;
        const result = await callLibrary(service(), libraryActor(context.agent), {
          action: definition.action,
          id: id as string | undefined,
          version: version as number | undefined,
          input,
        });
        if (definition.action === "file_info") {
          const { base64: _bytes, ...metadata } = result;
          return {
            content: [
              ...textResult(metadata).content,
              {
                type: "resource_link",
                name: result.name,
                uri: getUrl(`v1/library/${id}/files/${input.file}`),
                mimeType: "application/octet-stream",
              },
            ],
          };
        }
        return textResult(result);
      },
    })),
  };
}
