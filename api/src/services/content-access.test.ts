import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { organizationMember, currentOrganization } from "./organization.js";
import { contentAccess } from "./content-access.js";
import { ToolRegistry, type Toolkit, type ToolContext } from "./toolkits/registry.js";
import { builtInApiToolkits } from "./toolkits/builtins.js";

afterEach(() => vi.unstubAllEnvs());

const person = (userId: string, admin = false): ToolContext => ({
  requestId: "content-check",
  signal: new AbortController().signal,
  agent: {
    name: "admin",
    admin,
    dailyBudgetBytes: 1000,
    connectedApp: {
      ...organizationMember(userId),
      keyId: "agent-key",
      admin,
      expires: Date.now() + 60_000,
    },
  },
});

function packageFor(scope: "private" | "assigned" | "global"): Toolkit {
  return {
    id: "owned",
    name: "Personal method",
    version: "1.0.0",
    description: "Owner's content",
    authentication: "Toolstack identity",
    content: contentAccess.parse({
      id: "personal-method",
      owner: "alice",
      visibility: scope,
      ...(scope === "assigned" ? { assignedTo: ["bob"] } : {}),
    }),
    tools: [
      {
        name: "owned_read",
        description: "Read the authorized content",
        input: z.object({}).strict(),
        execute: () => ({ content: [{ type: "text", text: "private output" }] }),
      },
    ],
    workflows: [
      {
        id: "owned_method",
        name: "Personal procedure",
        version: "1.0.0",
        description: "Owned instructions",
        input: z.object({}),
        instructions: "Private working method",
        dependencies: [{ tool: "owned_read", version: "1.0.0" }],
        references: [
          {
            id: "anchor",
            title: "Private reference",
            mediaType: "text/plain",
            content: "private reference",
          },
        ],
        outputs: ["Authorized result"],
        checks: ["Check result"],
        policy: {
          runtime: "worker",
          authority: "read",
          maxDurationMs: 1000,
          retry: "Reuse key",
          cancellation: "Stop reading",
        },
      },
    ],
  };
}

test("private content is available to its person and hidden from other administrators", async () => {
  const registry = new ToolRegistry([packageFor("private")]);
  const alice = person("alice"),
    bob = person("bob", true);
  expect(registry.catalog(alice).toolkits[0].content).toEqual({
    id: "personal-method",
    orgId: currentOrganization().id,
    owner: "alice",
    visibility: "private",
  });
  expect(registry.getWorkflow("owned_method", alice).instructions).toBe("Private working method");
  expect(registry.catalog(bob).toolkits).toEqual([]);
  expect(registry.list(bob)).toEqual([]);
  expect(registry.search({ query: "owned", limit: 20, offset: 0 }, bob).tools).toEqual([]);
  expect(() => registry.describe("owned_read", bob)).toThrow("unavailable");
  expect(() => registry.getWorkflow("owned_method", bob)).toThrow("unavailable");
  expect(() => registry.workflowReference("owned_method", "anchor", "1.0.0", bob)).toThrow(
    "unavailable",
  );
  await expect(registry.execute("owned_read", {}, bob)).rejects.toMatchObject({
    code: "tool_unavailable",
  });
  await expect(registry.execute("owned_read", {}, alice)).resolves.toMatchObject({
    content: [{ text: "private output" }],
  });
});

test("assignment uses the person rather than the worker key or its admin flag", async () => {
  const registry = new ToolRegistry([packageFor("assigned")]);
  expect(registry.list(person("alice"))).toHaveLength(1);
  expect(registry.list(person("bob"))).toHaveLength(1);
  expect(registry.list(person("carol", true))).toEqual([]);
  expect(registry.catalog(person("bob")).toolkits[0].content).not.toHaveProperty("assignedTo");
  vi.stubEnv("STEEL_USER_ID", "alice");
  const direct = person("alice");
  delete (direct.agent as { connectedApp?: unknown }).connectedApp;
  expect(registry.list(direct)).toHaveLength(1);
  // A gateway identity takes precedence over the local fallback binding.
  expect(registry.list(person("carol", true))).toEqual([]);
});

test("global publication preserves the operation's independent authorization", async () => {
  const definition = packageFor("global");
  definition.tools[0].authorize = (context) => context.agent.connectedApp?.userId !== "carol";
  const registry = new ToolRegistry([definition]);
  expect(registry.list(person("bob"))).toHaveLength(1);
  expect(registry.list(person("carol"))).toEqual([]);
  await expect(registry.execute("owned_read", {}, person("carol"))).rejects.toMatchObject({
    code: "tool_unavailable",
  });
});

test("content defaults to private and publishing policy changes the catalog release", () => {
  expect(contentAccess.parse({ id: "example", owner: "alice" }).visibility).toBe("private");
  expect(
    contentAccess.safeParse({ id: "example", owner: "alice", visibility: "assigned" }).success,
  ).toBe(false);
  const privateRegistry = new ToolRegistry([packageFor("private")]);
  const sharedRegistry = new ToolRegistry([packageFor("assigned")]);
  expect(privateRegistry.release).not.toBe(sharedRegistry.release);
  expect(builtInApiToolkits().some((toolkit) => toolkit.id === "muse")).toBe(false);
  expect(
    () => new ToolRegistry([{ ...packageFor("private"), content: null } as unknown as Toolkit]),
  ).toThrow();
});
