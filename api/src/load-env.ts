import { loadEnvFile } from "node:process";

// Production supplies environment variables directly; local development uses .env.
try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
