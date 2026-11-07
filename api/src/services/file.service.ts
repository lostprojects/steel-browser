import { ZipArchive } from "archiver";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import fs from "fs";
import { tmpdir } from "os";
import path, { resolve } from "path";
import { Readable } from "stream";
import { env } from "../env.js";

interface File {
  size: number;
  lastModified: Date;
}

export interface FileServiceOptions {
  baseFilesPath?: string;
  archiveDir?: string;
}

export class FileService {
  private baseFilesPath: string;
  private static instance: FileService | null = null;
  private archiveDir: string;
  private archivePath: string;
  // Only active requests occupy this map. Separate request-scoped services for
  // the same session share the build and observe mutations during compression.
  private static archives = new Map<string, { dirty: boolean; promise: Promise<string> }>();

  public constructor(options: FileServiceOptions = {}) {
    this.baseFilesPath =
      options.baseFilesPath ??
      process.env.FILES_ROOT ??
      (env.NODE_ENV === "development" ? path.join(tmpdir(), "files") : "/files");
    this.archiveDir = options.archiveDir ?? "/tmp/.steel";
    this.archivePath = path.join(this.archiveDir, "files.zip");

    fs.mkdirSync(this.baseFilesPath, { recursive: true });
  }

  public static getInstance() {
    if (!FileService.instance) {
      FileService.instance = new FileService();
    }
    return FileService.instance;
  }

  private markArchiveDirty() {
    const archive = FileService.archives.get(this.archivePath);
    if (archive) archive.dirty = true;
  }

  private getSafeFilePath(relativePath: string) {
    const resolvedPath = resolve(this.baseFilesPath, relativePath);
    if (
      !resolvedPath.startsWith(this.baseFilesPath + path.sep) &&
      resolvedPath !== this.baseFilesPath
    ) {
      throw new Error("Invalid path");
    }
    return resolvedPath;
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.stat(filePath);

      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  public async saveFile({
    filePath,
    stream,
  }: {
    filePath: string;
    stream: Readable;
  }): Promise<File & { path: string }> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });

    const safeFilePath = this.getSafeFilePath(filePath);
    const parentDir = path.dirname(safeFilePath);
    await fs.promises.mkdir(parentDir, { recursive: true });

    try {
      await fs.promises.writeFile(safeFilePath, stream);
      const stats = await fs.promises.stat(safeFilePath);
      const file: File = {
        size: stats.size,
        lastModified: stats.mtime,
      };
      console.log(`File saved: ${safeFilePath}, Size: ${file.size}`);
      this.markArchiveDirty();
      return { ...file, path: safeFilePath };
    } catch (error) {
      console.error(`[FileService] Error saving file ${safeFilePath}:`, error);

      try {
        if (await this.exists(safeFilePath)) {
          await fs.promises.unlink(safeFilePath);
        }
      } catch (cleanupErr) {
        console.error(
          `[FileService] Failed to cleanup file ${safeFilePath} after save error:`,
          cleanupErr,
        );
      }
      throw error;
    }
  }

  public async downloadFile({
    filePath,
  }: {
    filePath: string;
  }): Promise<{ stream: Readable } & File> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });
    const safeFilePath = this.getSafeFilePath(filePath);

    try {
      const stats = await fs.promises.stat(safeFilePath);
      if (!stats.isFile()) {
        throw new Error(`Requested path is not a file: ${safeFilePath}`);
      }
      const file: File = {
        size: stats.size,
        lastModified: stats.mtime,
      };
      const stream = fs.createReadStream(safeFilePath);
      return {
        stream,
        ...file,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${safeFilePath}`);
      }
      console.error(`[FileService] Error accessing file ${safeFilePath} for download:`, error);
      throw new Error(`File not found or inaccessible: ${safeFilePath}`);
    }
  }

  public async getFile({ filePath }: { filePath: string }): Promise<File> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });
    const safeFilePath = this.getSafeFilePath(filePath);

    try {
      const stats = await fs.promises.stat(safeFilePath);
      if (!stats.isFile()) {
        throw new Error(`Requested path is not a file: ${safeFilePath}`);
      }
      const file: File = {
        size: stats.size,
        lastModified: stats.mtime,
      };
      return file;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${safeFilePath}`);
      }
      console.error(`[FileService] Error accessing file ${safeFilePath} for getFile:`, error);
      throw new Error(`File not found or inaccessible: ${safeFilePath}`);
    }
  }

  public async listFiles(): Promise<Array<{ path: string } & File>> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });

    const allFiles: Array<{ path: string } & File> = [];

    const collectFilesRecursively = async (currentDir: string) => {
      try {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(currentDir, entry.name);
          if (entry.isFile()) {
            try {
              const stats = await fs.promises.stat(entryPath);
              allFiles.push({
                path: entryPath,
                size: stats.size,
                lastModified: stats.mtime,
              });
            } catch (statError) {
              console.error(
                `[FileService] Error getting stats for file ${entryPath} during listFiles:`,
                statError,
              );
            }
          } else if (entry.isDirectory()) {
            await collectFilesRecursively(entryPath);
          }
        }
      } catch (readDirError) {
        console.error(
          `[FileService] Error reading directory ${currentDir} during listFiles:`,
          readDirError,
        );
      }
    };

    try {
      await collectFilesRecursively(this.baseFilesPath);
      allFiles.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
      return allFiles;
    } catch (error) {
      console.error(
        `[FileService] Error listing files recursively from ${this.baseFilesPath}:`,
        error,
      );
      return [];
    }
  }

  public async deleteFile({ filePath }: { filePath: string }): Promise<void> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });
    const safeFilePath = this.getSafeFilePath(filePath);

    if (!(await this.exists(safeFilePath))) {
      console.log(
        `[FileService] File ${safeFilePath} not found on disk during delete operation. Skipping.`,
      );
      return;
    }

    try {
      const stats = await fs.promises.stat(safeFilePath);
      if (!stats.isFile()) {
        console.warn(`[FileService] Path ${safeFilePath} is not a file. Skipping delete.`);
        return;
      }
      await fs.promises.unlink(safeFilePath);
      console.log(`[FileService] File deleted: ${safeFilePath}`);
      this.markArchiveDirty();
    } catch (unlinkError) {
      console.error(`Error unlinking file ${safeFilePath}:`, unlinkError);
      throw unlinkError;
    }

    return;
  }

  public async cleanupFiles(): Promise<void> {
    console.log(`[FileService cleanupFiles] Starting cleanup for directory: ${this.baseFilesPath}`);

    await FileService.archives.get(this.archivePath)?.promise.catch((error) => {
      console.warn("[FileService] Archive failed before cleanup:", error);
    });

    try {
      const archivePath = path.join(this.archiveDir, "files.zip");
      if (fs.existsSync(archivePath)) {
        await fs.promises.unlink(archivePath);
        console.log(`[FileService cleanupFiles] Deleted archive file: ${archivePath}`);
      }

      const archiveDir = await fs.promises.readdir(this.archiveDir).catch(() => []);
      for (const file of archiveDir) {
        if (file.startsWith("files-") && file.endsWith(".zip.tmp")) {
          const tempFilePath = path.join(this.archiveDir, file);
          await fs.promises.unlink(tempFilePath).catch((err) => {
            console.error(
              `[FileService cleanupFiles] Error deleting temp archive ${tempFilePath}:`,
              err,
            );
          });
        }
      }
    } catch (err: any) {
      console.error(`[FileService cleanupFiles] Error cleaning up archive files:`, err);
    }

    try {
      const files = await fs.promises.readdir(this.baseFilesPath);
      for (const file of files) {
        await fs.promises.rm(path.join(this.baseFilesPath, file), {
          recursive: true,
          force: true,
        });
      }
      console.log(
        `[FileService cleanupFiles] Cleared contents of directory: ${this.baseFilesPath}`,
      );
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(
          `[FileService cleanupFiles] Error cleaning directory ${this.baseFilesPath}:`,
          err,
        );
      }
    }
    this.markArchiveDirty();
  }

  public getBaseFilesPath(): string {
    return this.baseFilesPath;
  }

  public getArchivePath(): Promise<string> {
    const existing = FileService.archives.get(this.archivePath);
    if (existing) return existing.promise;

    const job = { dirty: true, promise: Promise.resolve("") };
    FileService.archives.set(this.archivePath, job);
    job.promise = (async () => {
      do {
        job.dirty = false;
        await this.createArchive();
      } while (job.dirty);
      return this.archivePath;
    })().finally(() => FileService.archives.delete(this.archivePath));
    return job.promise;
  }

  private async createArchive(): Promise<void> {
    await fs.promises.mkdir(this.baseFilesPath, { recursive: true });
    await fs.promises.mkdir(this.archiveDir, { recursive: true });
    const temporary = path.join(this.archiveDir, `files-${randomUUID()}.zip.tmp`);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const output = fs.createWriteStream(temporary, { flags: "wx" });
    archive.on("warning", (error) => {
      // A browser can remove a download while the directory is being read.
      if (error.code !== "ENOENT") archive.destroy(error);
    });
    archive.directory(this.baseFilesPath, false);
    try {
      await Promise.all([pipeline(archive, output), archive.finalize()]);
      await fs.promises.rename(temporary, this.archivePath);
    } finally {
      archive.abort();
      archive.destroy();
      output.destroy();
      await fs.promises.rm(temporary, { force: true });
    }
  }
}
