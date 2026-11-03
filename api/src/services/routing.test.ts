import { describe, expect, it } from "vitest";
import { validPayload } from "./routing.js";
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
  });
});
