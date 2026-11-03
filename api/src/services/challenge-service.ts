// Clear observed interstitials with isolated reads and native input. Puzzles
// needing visual interpretation stay open for the owner; do not guess answers.
import type { BrowserSession } from "./browser-session.js";
import { QuietInput } from "./quiet-input.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const marker =
  /just a moment|ddos-guard|human verification|checking your browser|browser validation|verify you are human|attention required/i;
export const challengeMarker = (text: string) => marker.test(text);
type Box = [number, number, number, number];
type Frame = { id: string; src: string; box: Box };
type Detection = { kind: "wait" | "checkbox" | "drag" | "puzzle" | "clear"; points?: number[] };

export async function detectChallenge(
  session: BrowserSession,
  targetId?: string,
): Promise<Detection> {
  const pages = await session.getAllPages();
  const page = targetId ? pages.find((p) => (p.target() as any)._targetId === targetId) : pages[0];
  if (!page) throw new Error("Challenge page no longer exists");
  const state = await page.evaluate(() => {
    const box = (e: Element | null): Box | null => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return r.width && r.height && r.x >= 0 && r.y >= 0 ? [r.x, r.y, r.width, r.height] : null;
    };
    const label = (pattern: string) =>
      [...document.querySelectorAll("div,span,button")]
        .filter((e) => new RegExp(pattern, "i").test(e.textContent?.trim() ?? ""))
        .map(box)
        .find(Boolean);
    return {
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 4000),
      solved: [
        ...document.querySelectorAll<HTMLInputElement>(
          '[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]',
        ),
      ].some((e) => e.value.length > 20),
      frames: [...document.querySelectorAll("iframe")]
        .map((e) => ({ id: e.id, src: e.src, box: box(e) }))
        .filter((e) => e.box),
      drag: label("^Drag$"),
      drop: label("^(Drop|Place) here$"),
      verify: label("^Verify You Are Human$"),
    };
  });
  if (state.solved) return { kind: "clear" };
  if (/human verification/i.test(state.text) && state.drag && state.drop)
    return { kind: "drag", points: [...state.drag, ...state.drop, ...(state.verify ?? [])] };
  // Inventory finds owners even when Turnstile is inside a closed shadow root.
  const client = await page.createCDPSession();
  try {
    const root = await client.send("Page.getFrameTree");
    const inventory: Array<{ id: string; url: string }> = [];
    const visit = (tree: any) => {
      inventory.push(tree.frame);
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(root.frameTree);
    const targets = await client.send("Target.getTargets");
    for (const t of targets.targetInfos)
      if (t.type === "iframe") inventory.push({ id: t.targetId, url: t.url });
    for (const frame of inventory) {
      if (!/challenges\.cloudflare\.com\//.test(frame.url)) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { backendNodeId } = await client.send("DOM.getFrameOwner", { frameId: frame.id });
          const { model } = await client.send("DOM.getBoxModel", { backendNodeId });
          const q = model.content;
          const box: Box = [q[0], q[1], q[2] - q[0], q[7] - q[1]];
          if (box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0)
            state.frames.push({ id: frame.id, src: frame.url, box });
          break;
        } catch {
          await sleep(100);
        }
      }
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
  for (const frame of state.frames as Frame[]) {
    const [x, y, , height] = frame.box;
    if (frame.id === "ddg-iframe")
      return height > 200 ? { kind: "puzzle" } : { kind: "checkbox", points: [x + 64, y + 36] };
    if (
      /recaptcha\/api2\/bframe/.test(frame.src) ||
      (/hcaptcha\.com/.test(frame.src) && height > 200)
    )
      return { kind: "puzzle" };
    if (/challenges\.cloudflare\.com/.test(frame.src) && height < 120)
      return { kind: "checkbox", points: [x + 30, y + height / 2] };
    if (/recaptcha\/api2\/anchor|hcaptcha\.com.*checkbox/.test(frame.src))
      return { kind: "checkbox", points: [x + 28, y + height / 2] };
  }
  if (marker.test(state.title) || /verifying.*cloudflare/i.test(state.text))
    return { kind: "wait" };
  if (
    state.text.length < 1500 &&
    /captcha|are you a robot|unusual traffic/i.test(state.title + state.text)
  )
    return { kind: "puzzle" };
  return { kind: "clear" };
}

export async function clearChallenge(
  session: BrowserSession,
  targetId?: string,
  budgetMs = 60_000,
) {
  if (!session.display.name) throw new Error("Challenge input requires the session display");
  const { width, height } = session.getDimensions();
  const input = new QuietInput(session.display.name, width, height);
  const pages = await session.getAllPages();
  const page = targetId ? pages.find((p) => (p.target() as any)._targetId === targetId) : pages[0];
  if (!page) throw new Error("Challenge page no longer exists");
  const pointer = async (type: string, x: number, y: number) => {
    const offset = await page.evaluate(() => ({
      x: screenX + (outerWidth - innerWidth) / 2,
      y: screenY + outerHeight - innerHeight - (outerWidth - innerWidth) / 2,
    }));
    await input.mouse({ type, x, y, button: "left" }, offset);
  };
  const click = async (x: number, y: number) => {
    await pointer("mousePressed", x, y);
    await sleep(90);
    await pointer("mouseReleased", x, y);
  };
  const actions: string[] = [];
  const attempts = { checkbox: 0, drag: 0 };
  let detection: Detection = { kind: "wait" };
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && session.status === "live") {
    session.touch();
    try {
      detection = await detectChallenge(session, targetId);
    } catch {
      await sleep(500);
      continue;
    }
    if (detection.kind === "clear") {
      session.challenge = undefined;
      return { status: "cleared", actions, sessionId: session.id };
    }
    if (detection.kind === "puzzle") break;
    if (detection.kind === "checkbox" && detection.points && attempts.checkbox++ < 3) {
      await sleep(1000);
      await click(detection.points[0], detection.points[1]);
      actions.push("checkbox");
    } else if (detection.kind === "drag" && detection.points && attempts.drag++ < 2) {
      const p = detection.points;
      await pointer("mouseMoved", p[0] + p[2] / 2, p[1] + p[3] / 2);
      await pointer("mousePressed", p[0] + p[2] / 2, p[1] + p[3] / 2);
      await pointer("mouseMoved", p[4] + p[6] / 2, p[5] + p[7] / 2);
      await pointer("mouseReleased", p[4] + p[6] / 2, p[5] + p[7] / 2);
      if (p.length > 8) {
        await sleep(700);
        await click(p[8] + p[10] / 2, p[9] + p[11] / 2);
      }
      actions.push("drag");
    }
    await sleep(2500);
  }
  session.challenge = { status: "challenge_required", kind: detection.kind, url: page.url() };
  return {
    ...session.challenge,
    sessionId: session.id,
    actions,
    screenshot: await input.screenshot(),
    noVncUrl: session.info().noVncUrl,
    idleTimeoutMs: 600_000,
  };
}
