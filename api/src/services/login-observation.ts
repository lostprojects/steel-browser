// Observes an existing login without input or password submission. Persist only
// metadata; member HTML and account values must remain inside the service.
import type { PageRead as Page } from "./browser-control.js";
import type { BrowserSession } from "./browser-session.js";
export const memberReads = {
  ancestry: {
    url: "https://www.ancestry.com/family-tree/tree",
    marker: "#navAccountUsername,#navAccount",
  },
  newspapers: {
    url: "https://www.newspapers.com/account/edit-profile/",
    marker: '[data-cy="member-menu"],a[href^="/account/edit-profile"]',
  },
  fold3: {
    url: "https://www.fold3.com/search?keywords=Project%20Blue%20Book",
    marker: 'a[href="/signoff"],[data-cy="footer-sign-out"]',
  },
};
export async function observeMemberRead(session: BrowserSession, site: keyof typeof memberReads) {
  const spec = memberReads[site];
  const before = (session.proxyServer?.rxBytes ?? 0) + (session.proxyServer?.txBytes ?? 0);
  const started = Date.now();
  await session.prepareCommands();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let fresh: Page | undefined;
    try {
      fresh = await session.createReadPage();
      return { ...(await readPage(fresh)), readAttempts: attempt };
    } catch (error) {
      lastError = error;
      // A SPA can replace its execution context while its first payload loads.
      // Retry a fresh read on the same identity; no input or login is involved.
      session
        .getLogger("login-check")
        .warn(
          { site, attempt, errorType: error instanceof Error ? error.name : "unknown" },
          "Authenticated read failed before observation",
        );
    } finally {
      await fresh?.close().catch(() => undefined);
    }
  }
  throw lastError;
  async function readPage(page: Page) {
    session.lastNavigation = Date.now();
    const response = await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const observed = await page.evaluate(
      ({ marker, host, pathname }) => {
        const visible = (e: Element) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const text = document.body?.innerText ?? "";
        const inputs = [...document.querySelectorAll("input")].filter(visible);
        const deviceCheck =
          /(?:check your email|verification code|verify it.s you|new device|confirm it.s you|authenticator code|security key required|use (?:a |your )?passkey)/i.test(
            text,
          ) || inputs.some((e) => e.matches('[autocomplete="one-time-code"]'));
        const signInPrompt =
          /\/(?:signin|sign-in|login)(?:[/?]|$)/i.test(location.pathname) ||
          inputs.some((e) => e.type === "password") ||
          [...document.querySelectorAll("a,button")].some(
            (e) => visible(e) && /^(?:sign|log)\s*in$/i.test(e.textContent?.trim() ?? ""),
          );
        const memberMarker = location.hostname === host && !!document.querySelector(marker);
        const memberPayload =
          location.hostname === host &&
          location.pathname === pathname &&
          /account|profile|settings|membership|trees|search|results/i.test(text) &&
          text.length > 200;
        return {
          path: pathname,
          memberMarker,
          memberPayload,
          signInPrompt,
          deviceCheck,
          readBytes: new TextEncoder().encode(document.documentElement.outerHTML).length,
        };
      },
      {
        marker: spec.marker,
        host: new URL(spec.url).hostname,
        pathname: new URL(spec.url).pathname,
      },
    );
    const ok =
      observed.memberMarker &&
      observed.memberPayload &&
      !observed.signInPrompt &&
      !observed.deviceCheck &&
      (!response || response.status() < 400);
    return {
      ...observed,
      status: ok ? "ok" : "failed",
      check: observed.deviceCheck
        ? "device"
        : observed.signInPrompt
          ? "sign_in_prompt"
          : ok
            ? "none"
            : "member_payload_missing",
      httpStatus: response?.status() ?? null,
      exitIp: session.exit?.ip,
      proxyBytes:
        (session.proxyServer?.rxBytes ?? 0) + (session.proxyServer?.txBytes ?? 0) - before,
      durationMs: Date.now() - started,
    };
  }
}
