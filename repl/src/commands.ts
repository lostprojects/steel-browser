import { randomUUID } from "node:crypto";

type CommandResult = {
  ok: boolean;
  effect: "none" | "applied" | "unknown";
  error?: { code: string; message: string; reason?: string };
  snapshot?: string;
};

type CommandResponse = {
  next?: string;
  page: { tab: string; url: string; title: string } | null;
  execution: { id: string; state: string; error?: { code: string; message: string } };
  results: CommandResult[];
};

const apiUrl = (process.env.STEEL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiKey = process.env.STEEL_API_KEY;

async function post<T>(
  path: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "steel-api-key": apiKey } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  if (response.status === 404 && path.endsWith("/commands")) {
    throw new Error("The Commands API is off. Start the server with ENABLE_COMMANDS_API=true.");
  }
  const data = (await response.json()) as T & { error?: unknown };
  if (!response.ok || data.error) {
    throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function runCommands(sessionId: string, body: object): Promise<CommandResponse> {
  const path = `/v1/sessions/${sessionId}/commands`;
  let response = await post<CommandResponse>(path, body, {
    "Idempotency-Key": randomUUID(),
  });
  const deadline = Date.now() + 120_000;
  while (["queued", "running"].includes(response.execution.state)) {
    if (Date.now() >= deadline) throw new Error("Commands did not finish within two minutes");
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await post<CommandResponse>(path, {
      commands: [{ command: "status", execution: response.execution.id }],
    });
  }
  if (response.execution.state !== "completed") {
    throw new Error(
      `Execution ${response.execution.state}: ${response.execution.error?.message ?? "no result"}`,
    );
  }
  const failed = response.results.find((result) => !result.ok);
  if (failed) {
    throw new Error(`Command failed: ${failed.error?.code} ${failed.error?.message}`);
  }
  return response;
}

async function run() {
  const session = await post<{ id: string }>("/v1/sessions", {
    mode: process.env.STEEL_MODE ?? "agent",
  });

  try {
    const opened = await runCommands(session.id, {
      commands: [
        { command: "navigate", url: "https://example.com" },
        { command: "snapshot", interactive: true },
      ],
    });
    const snapshot = opened.results[1]?.snapshot ?? "";
    console.log(snapshot);

    const ref = snapshot
      .split("\n")
      .find((line) => line.trimStart().startsWith("- link "))
      ?.match(/ref=(e\d+)/)?.[1];
    if (!ref) {
      console.log("No link found in the snapshot.");
      return;
    }

    const clicked = await runCommands(session.id, {
      after: opened.next,
      commands: [{ command: "click", target: ref }],
    });
    console.log(`Clicked ${ref}. Page title: ${clicked.page?.title} (${clicked.page?.url})`);
  } finally {
    await post(`/v1/sessions/${session.id}/release`, {});
  }
}

await run();
