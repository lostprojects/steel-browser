import { expect, test, vi } from "vitest";
import { museContentToolkit } from "./muse-content.js";

test("Muse returns versioned provenance and validated empty results from fixed read endpoints", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ documents: [] }))
    .mockResolvedValueOnce(
      Response.json({ key: "page:home", version: 57, value: { title: "The Muse" } }),
    );
  const toolkit = museContentToolkit("owner", request);
  const list = await toolkit.actions[0].run({}, "fixture-key", new AbortController().signal);
  expect(list).toMatchObject({
    state: "succeeded",
    estimatedCostMicros: 0,
    data: { sourceId: "muse:documents", documents: [] },
  });
  const document = await toolkit.actions[1].run(
    { connection: "api:muse", key: "page:home" },
    "fixture-key",
    new AbortController().signal,
  );
  expect(document).toMatchObject({
    state: "succeeded",
    data: {
      sourceId: "muse:page:home@57",
      document: { version: 57, value: { title: "The Muse" } },
    },
  });
  expect(request.mock.calls[1][0].toString()).toBe(
    "https://musehotel.co/admin/api/document?key=page%3Ahome",
  );
  expect(request.mock.calls[1][1]).toMatchObject({
    redirect: "manual",
    headers: { authorization: "Bearer fixture-key" },
  });
});
test("Muse refuses redirects, mismatched documents, malformed data and arbitrary keys", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://other.test" } }),
    )
    .mockResolvedValueOnce(Response.json({ key: "business", version: 1, value: {} }))
    .mockResolvedValueOnce(Response.json({ documents: "invalid" }));
  const toolkit = museContentToolkit("owner", request),
    signal = new AbortController().signal;
  await expect(toolkit.actions[0].run({}, "fixture", signal)).rejects.toMatchObject({
    code: "provider_auth_required",
  });
  await expect(
    toolkit.actions[1].run({ connection: "api:muse", key: "page:home" }, "fixture", signal),
  ).rejects.toMatchObject({ code: "provider_invalid_response" });
  await expect(toolkit.actions[0].run({}, "fixture", signal)).rejects.toMatchObject({
    code: "provider_invalid_response",
  });
  await expect(
    toolkit.actions[1].run({ connection: "api:muse", key: "../rsvps" }, "fixture", signal),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(3);
});
