import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { FileService } from "../../services/file.service.js";
import { MB } from "../../utils/size.js";
import { FilesController } from "./files.controller.js";
import path from "node:path";
import { agentFor } from "../../utils/api-key.js";

async function routes(server: FastifyInstance) {
  const controller = (request: FastifyRequest) => {
    const id = (request.params as { sessionId: string }).sessionId;
    const agent = agentFor(request.raw)!;
    const owner = server.sessionPool.owner(id);
    if (!owner || (!agent.admin && owner.name !== agent.name))
      throw Object.assign(new Error("Session files are outside this agent's scope"), {
        statusCode: 403,
      });
    return new FilesController(
      new FileService({
        baseFilesPath: path.join(FileService.getInstance().getBaseFilesPath(), id),
        prebuiltArchiveDir: path.join(
          FileService.getInstance().getBaseFilesPath(),
          ".archives",
          id,
        ),
        watchFiles: false,
      }),
    );
  };

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: server.steelBrowserConfig.fileStorage?.maxSizePerSession ?? 100 * MB,
    },
    attachFieldsToBody: false,
  });

  server.post(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "upload_file",
        summary: "Upload a file",
        description:
          "Uploads a file to a session via `multipart/form-data` with a `file` field that accepts either binary data or a URL string to download from, and an optional `path` field for the file storage path.",
        tags: ["Files"],
        consumes: ["multipart/form-data"],
        body: $ref("FileUploadRequest"),
        response: {
          200: $ref("FileDetails"),
        },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
      }>,
      reply,
    ) => controller(request).handleFileUpload(server, request, reply),
  );

  server.head(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "head_file",
        summary: "Head a file",
        description: "Head a file from a session",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      controller(request).handleFileHead(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "download_file",
        summary: "Download a file",
        description: "Download a file from a session",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      controller(request).handleFileDownload(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "list_files",
        summary: "List files",
        description: "List all files from the session in descending order.",
        tags: ["Files"],
        response: {
          200: $ref("MultipleFiles"),
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
      }>,
      reply,
    ) => controller(request).handleFileList(server, request, reply),
  );

  server.delete(
    "/sessions/:sessionId/files/*",
    {
      schema: {
        operationId: "delete_file",
        summary: "Delete a file",
        description: "Delete a file from a session",
        tags: ["Files"],
        response: {
          204: {
            type: "null",
            description: "No content",
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string; "*": string } }>, reply) =>
      controller(request).handleFileDelete(server, request, reply),
  );

  server.delete(
    "/sessions/:sessionId/files",
    {
      schema: {
        operationId: "delete_all_files",
        summary: "Delete all files",
        description: "Delete all files from a session",
        tags: ["Files"],
        response: {
          204: {
            type: "null",
            description: "No content",
          },
        },
      },
    },

    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) =>
      controller(request).handleFileDeleteAll(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/files.zip",
    {
      schema: {
        operationId: "download_archive",
        summary: "Download archive",
        description: "Download all files from the session as a zip archive.",
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) =>
      controller(request).handleDownloadArchive(server, request, reply),
  );
}

export default routes;
