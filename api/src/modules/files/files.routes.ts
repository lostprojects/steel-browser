import { retryKey } from "../../utils/idempotency.js";
import { browserApplication } from "../../services/browser-application.js";
import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { FileService } from "../../services/file.service.js";
import { MB } from "../../utils/size.js";
import { FilesController } from "./files.controller.js";
import path from "node:path";
import { agentFor } from "../../utils/api-key.js";
import { z } from "zod";
import { selectedSession, selectedTransfers } from "../sessions/sessions.controller.js";
import { TransferAck } from "./files.schema.js";
import { attachmentContentDisposition } from "../../utils/content-disposition.js";

async function routes(server: FastifyInstance) {
  const deliverySchema = (operationId: string, summary: string) => ({
    operationId,
    summary,
    tags: ["Files"],
    response: { 200: $ref("DeliveryDetails") },
  });
  const transfer = (request: FastifyRequest) => {
    const { transferId } = z
      .object({ transferId: z.string().uuid() })
      .passthrough()
      .parse(request.params);
    return { files: selectedTransfers(server, request), id: transferId };
  };
  server.get(
    "/sessions/:sessionId/transfers",
    { schema: { summary: "List prepared downloads", tags: ["Files"] } },
    async (request) => ({ data: selectedTransfers(server, request).list() }),
  );
  server.post(
    "/sessions/:sessionId/transfers/:transferId/share",
    {
      schema: deliverySchema(
        "share_download",
        "Keep a ready download available after its browser closes",
      ),
    },
    async (request) => {
      const { files, id } = transfer(request);
      return files.share(id);
    },
  );
  server.post(
    "/sessions/:sessionId/transfers",
    {
      schema: {
        ...deliverySchema(
          "prepare_delivery",
          "Prepare one session file or source URL for verified delivery",
        ),
        body: $ref("TransferRequest"),
        response: { 200: $ref("DeliveryDetails"), 202: $ref("DeliveryDetails") },
      },
    },
    async (request, reply) => {
      const result = await browserApplication(server.sessionPool).prepareDelivery(
        {
          agent: agentFor(request.raw)!,
          idempotencyKey: retryKey(request.headers),
        },
        (request.params as { sessionId: string }).sessionId,
        request.body,
      );
      return reply.code(result.state === "receiving" ? 202 : 200).send(result);
    },
  );
  server.get(
    "/sessions/:sessionId/transfers/:transferId",
    {
      schema: deliverySchema("delivery_status", "Inspect a delivery; DELETE this URL to cancel it"),
    },
    async (request) => {
      const { files, id } = transfer(request);
      return files.status(id);
    },
  );
  server.post(
    "/sessions/:sessionId/transfers/:transferId/ack",
    {
      schema: {
        ...deliverySchema(
          "acknowledge_delivery",
          "Delete remote bytes after verified, durable local publication",
        ),
        body: $ref("TransferAck"),
      },
    },
    async (request) => {
      const { sha256 } = TransferAck.parse(request.body);
      const { files, id } = transfer(request);
      return files.acknowledge(id, sha256);
    },
  );
  server.delete(
    "/sessions/:sessionId/transfers/:transferId",
    {
      schema: deliverySchema(
        "cancel_delivery",
        "Cancel preparation or discard an unwanted delivery",
      ),
    },
    async (request) => {
      const { files, id } = transfer(request);
      return files.cancel(id);
    },
  );
  server.route({
    method: ["GET", "HEAD"],
    url: "/sessions/:sessionId/transfers/:transferId/content",
    schema: { summary: "Stream immutable bytes; supports Range and If-Match", tags: ["Files"] },
    handler: async (request, reply) => {
      const { files, id } = transfer(request);
      const info = files.status(id);
      if (info.state !== "ready")
        return reply
          .code(info.state === "receiving" ? 409 : 410)
          .send({ error: "Delivery is not ready" });
      const etag = `"${info.sha256}"`;
      if (request.headers["if-match"] && request.headers["if-match"] !== etag)
        return reply.code(412).send({ error: "Delivery changed" });
      let start = 0,
        end = info.bytes! - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (
          !match ||
          !Number.isSafeInteger(Number(match[1])) ||
          Number(match[1]) >= info.bytes! ||
          (match[2] && Number(match[2]) < Number(match[1]))
        )
          return reply.code(416).header("content-range", `bytes */${info.bytes}`).send();
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), end);
        reply.code(206).header("content-range", `bytes ${start}-${end}/${info.bytes}`);
      }
      const { stream } = await files.read(id, start, info.bytes ? end : undefined);
      reply
        .header("content-length", Math.max(0, end - start + 1))
        .header("content-type", "application/octet-stream")
        .header("etag", etag)
        .header("x-content-sha256", info.sha256)
        .header("accept-ranges", "bytes")
        .header("cache-control", "no-store")
        .header("content-disposition", attachmentContentDisposition(info.name));
      const timer = setTimeout(() => stream.destroy(new Error("Delivery read deadline")), 600_000);
      timer.unref();
      stream.once("close", () => clearTimeout(timer));
      reply.raw.once("close", () => stream.destroy());
      if (request.method === "HEAD") {
        stream.destroy();
        return reply.send();
      }
      return reply.send(stream);
    },
  });
  const controller = (request: FastifyRequest) => {
    const id = (request.params as { sessionId: string }).sessionId;
    const agent = agentFor(request.raw)!;
    const owner = server.sessionPool.owner(id);
    if (!owner || (!agent.admin && owner.name !== agent.name))
      throw Object.assign(new Error("Session files are outside this agent's scope"), {
        statusCode: 403,
      });
    const session = selectedSession(server, request);
    return new FilesController(
      new FileService({
        baseFilesPath: path.join(FileService.getInstance().getBaseFilesPath(), id),
        archiveDir: path.join(FileService.getInstance().getBaseFilesPath(), ".archives", id),
      }),
      (name) => session.transfers.nameFor(name),
      (name) => session.transfers.rawReady(name),
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
