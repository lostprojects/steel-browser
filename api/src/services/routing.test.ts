import { describe, expect, it, vi } from "vitest";
import { validPayload, Routing } from "./routing.js";
import * as challenges from "./challenge-service.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostRoute } from "../utils/proxy.js";
describe("route payloads", () => {
  it("accepts Utah's real payload on 418 and rejects an empty successful page", () => {
    const html =
      "<title>Search</title><body>" + '<a href="/details/1">record</a>'.repeat(3) + "</body>";
    expect(validPayload(html, 418, {}, "udn").pass).toBe(true);
    expect(validPayload("<title>Search</title><body></body>", 200, {}, "udn").pass).toBe(false);
    expect(validPayload(html, 200, { "cf-mitigated": "challenge" }, "udn").pass).toBe(false);
  });
  it("keeps unknown CDNs and challenge providers on the residential exit", () => {
    expect(hostRoute("challenges.cloudflare.com")).toBe("residential");
    expect(hostRoute("check.ddos-guard.net")).toBe("residential");
    expect(hostRoute("unknown.example")).toBe("residential");
    expect(hostRoute("fonts.gstatic.com")).toBe("direct");
    expect(hostRoute("ads.doubleclick.net")).toBe("refused");
    expect(hostRoute("www.googletagmanager.com")).toBe("refused");
  });
  it("counts relative people links the same way as browser anchor hrefs", () => {
    const html =
      "<title>People</title><body>" + '<a href="person.html">person</a>'.repeat(10) + "</body>";
    expect(
      validPayload(html, 200, {}, "bizapedia", "https://www.bizapedia.com/people/john-smith.html")
        .payloads,
    ).toBe(10);
  });
  it.each([false, true])(
    "releases a challenged direct probe before escalating (retain=%s)",
    async (retain) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "routing-test-"));
      const released: string[] = [];
      const clear = vi.spyOn(challenges, "clearChallenge").mockImplementation(async (session) => {
        session.challenge = {
          status: "challenge_required",
          kind: "puzzle",
          url: "https://newspapers.lib.utah.edu/search",
        };
        return {
          ...session.challenge,
          sessionId: session.id,
          actions: [],
          screenshot: { data: "" },
          noVncUrl: "",
          idleTimeoutMs: 600000,
        } as any;
      });
      const pool = {
        create: async (options: any) => {
          const info = { proxyTxBytes: 0, proxyRxBytes: 0, directBytes: 0 };
          return {
            id: options.mode,
            status: "live",
            info: () => info,
            getPrimaryPage: async () => ({
              goto: async () => {},
              url: () => "https://newspapers.lib.utah.edu/search",
              evaluate: async () =>
                options.mode === "agent"
                  ? "<title>Human Verification</title>"
                  : '<a href="/details/1">record</a>'.repeat(3),
            }),
          };
        },
        release: async (id: string) => {
          released.push(id);
          return {};
        },
      };
      try {
        const result = await new Routing(pool as any, root).fetch(
          { url: "https://newspapers.lib.utah.edu/search", route: "udn", startRung: 2, retain },
          { name: "test", dailyBudgetBytes: 1000 },
        );
        expect(result.status).toBe("ok");
        expect(released).toEqual(retain ? ["agent"] : ["agent", "quiet"]);
      } finally {
        clear.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
