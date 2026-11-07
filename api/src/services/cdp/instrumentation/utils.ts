import type { Target, Protocol } from "puppeteer-core";
import { safeStringify } from "./storage/safe-json.js";

export function extractTargetId(target: Target): string {
  // Puppeteer and the quiet adapter expose this ID outside the public Target type.
  if ("_targetId" in target && typeof target._targetId === "string") return target._targetId;
  throw new Error("Browser target has no CDP target ID");
}

export function serializeRemoteObject(obj: Protocol.Runtime.RemoteObject): string {
  if (obj.value !== undefined) {
    return typeof obj.value === "object" ? safeStringify(obj.value) : String(obj.value);
  }
  return obj.description ?? "<unknown>";
}

export function formatLocation(stackTrace?: Protocol.Runtime.StackTrace): string | undefined {
  if (!stackTrace?.callFrames?.[0]) return undefined;
  const frame = stackTrace.callFrames[0];
  return `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
}
