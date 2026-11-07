import { z } from "zod";
import "./load-env.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["test", "development", "staging", "production", "preview"])
    .default("development"),
  HOST: z.string().optional().default("0.0.0.0"),
  DOMAIN: z.string().optional(),
  PORT: z.string().optional().default("3000"),
  USE_SSL: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  STEEL_API_KEY: z.string().optional(),
  MCP_TOOL_EXPOSURE: z.enum(["all", "discovery"]).default("all"),
  MAX_HTTP_FETCHES: z.coerce.number().int().min(1).max(64).optional(),
  HTTP_MEMORY_BUDGET_MB: z.coerce.number().int().positive().optional(),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_HEADLESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("true"),
  DISPLAY: z.string().optional().default(":10"),
  ENABLE_PDF_VIEWER: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  // Enabling Runtime and Log on a target makes Chrome serialize console
  // messages, which pages detect. False keeps page console output out of logs.
  CAPTURE_CONSOLE_EVENTS: z
    .string()
    .optional()
    .transform((val) => val !== "false" && val !== "0")
    .prefault("true"),
  DEFAULT_TIMEZONE: z.string().optional(),
  ENABLE_COMMANDS_API: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
});

export const env = envSchema.parse(process.env);
