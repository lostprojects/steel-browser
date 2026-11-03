import type { SessionPool } from "../services/session-pool.js";
import type { FileService } from "../services/file.service.js";
declare module "fastify" {
  interface FastifyInstance {
    sessionPool: SessionPool;
    fileService: FileService;
  }
}
