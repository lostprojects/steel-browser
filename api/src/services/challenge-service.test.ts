import { describe, expect, it, vi } from "vitest";
import { detectChallenge } from "./challenge-service.js";
import type { BrowserSession } from "./browser-session.js";
function fixture(
  state: any,
  send = vi.fn(async () => ({
    frameTree: { frame: { id: "root", url: "https://site.example" } },
    targetInfos: [],
  })),
) {
  const page = {
    evaluate: vi.fn(async () => ({ title: "", text: "", solved: false, frames: [], ...state })),
    createCDPSession: async () => ({ send, detach: async () => {} }),
  };
  return { getAllPages: async () => [page] } as unknown as BrowserSession;
}
describe("service challenges", () => {
  it("recognizes the tall DDoS-Guard puzzle without reading a replacing frame", async () => {
    expect(
      await detectChallenge(
        fixture({ frames: [{ id: "ddg-iframe", src: "", box: [20, 30, 300, 250] }] }),
      ),
    ).toEqual({ kind: "puzzle" });
  });
  it("uses frame inventory and retries a replaced Cloudflare owner", async () => {
    let reads = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "root", url: "https://site.example" },
            childFrames: [{ frame: { id: "cf", url: "https://challenges.cloudflare.com/frame" } }],
          },
        };
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "DOM.getFrameOwner") {
        if (++reads === 1) throw new Error("Document replaced");
        return { backendNodeId: 9 };
      }
      return { model: { content: [100, 200, 400, 200, 400, 260, 100, 260] } };
    });
    expect(await detectChallenge(fixture({}, send as any))).toEqual({
      kind: "checkbox",
      points: [130, 230],
    });
    expect(reads).toBe(2);
  });
});
