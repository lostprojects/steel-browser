import { z } from "zod";
import { config } from "dotenv";

config();

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
    .default("false"),
  CDP_REDIRECT_PORT: z.string().optional().default("9222"),
  CDP_DOMAIN: z.string().optional(),
  STEEL_API_KEY: z.string().optional(),
  PROXY_URL: z.string().optional(),
  DEFAULT_HEADERS: z
    .string()
    .optional()
    .transform((val) => (val ? JSON.parse(val) : {}))
    .pipe(z.record(z.string()).optional().default({})),
  KILL_TIMEOUT: z.string().optional().default("0"),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_HEADLESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("true"),
  DISPLAY: z.string().optional().default(":10"),
  ENABLE_CDP_LOGGING: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  // Enabling Runtime and Log on a target makes Chrome serialize console
  // messages, which pages detect. False keeps page console output out of logs.
  ENABLE_PDF_VIEWER: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  CAPTURE_CONSOLE_EVENTS: z
    .string()
    .optional()
    .transform((val) => val !== "false" && val !== "0")
    .default("true"),
  LOG_CUSTOM_EMIT_EVENTS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  ENABLE_VERBOSE_LOGGING: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  DEFAULT_TIMEZONE: z.string().optional(),
  TIMEZONE_SERVICE_URL: z.string().optional(),
  CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .default(""),
  FILTER_CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .default(""),
  DEBUG_CHROME_PROCESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  PROXY_INTERNAL_BYPASS: z.string().optional(),
  CHROME_USER_DATA_DIR: z.string().optional(),
  LOG_STORAGE_ENABLED: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  LOG_STORAGE_PATH: z.string().optional(),
  DISABLE_CHROME_SANDBOX: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  ENABLE_COMMANDS_API: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
});

export const env = envSchema.parse(process.env);
