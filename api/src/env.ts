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
  STEEL_API_KEY: z.string().optional(),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_HEADLESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("true"),
  DISPLAY: z.string().optional().default(":10"),
  ENABLE_PDF_VIEWER: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  // Enabling Runtime and Log on a target makes Chrome serialize console
  // messages, which pages detect. False keeps page console output out of logs.
  CAPTURE_CONSOLE_EVENTS: z
    .string()
    .optional()
    .transform((val) => val !== "false" && val !== "0")
    .default("true"),
  ENABLE_VERBOSE_LOGGING: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  DEFAULT_TIMEZONE: z.string().optional(),
  TIMEZONE_SERVICE_URL: z.string().optional(),
  PROXY_INTERNAL_BYPASS: z.string().optional(),
  ENABLE_COMMANDS_API: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
});

export const env = envSchema.parse(process.env);
