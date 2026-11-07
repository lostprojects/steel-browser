import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import puppeteer, { type Browser, type CDPSession, type Page, type Target } from "puppeteer-core";
import WebSocket, { type RawData, type Server } from "ws";

import type { BrowserSession } from "../../services/browser-session.js";
import { extractTargetId } from "../../services/cdp/instrumentation/utils.js";
import type {
  CloseTabEvent,
  GetSelectedTextEvent,
  KeyEvent,
  MouseEvent,
  NavigationEvent,
  PageInfo,
} from "../../types/casting.js";
import { getPageFavicon, getPageTitle, navigatePage } from "../../utils/casting.js";
import { type CastFormat, subscribeToScreencast } from "./page-screencast.js";

type CastEvent = MouseEvent | KeyEvent | NavigationEvent | CloseTabEvent | GetSelectedTextEvent;

function findTargetPage(pages: Page[], pageId: string | null, pageIndex: string | null) {
  if (pageId) return pages.find((page) => extractTargetId(page.target()) === pageId);
  if (pageIndex === null || !/^[0-9]+$/.test(pageIndex)) return undefined;
  const index = Number(pageIndex);
  return Number.isSafeInteger(index) ? pages[index] : undefined;
}

export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  browserSession: BrowserSession,
  params: Record<string, string> | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const id = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cast$/)?.[1];
  const session = browserSession.info();
  if (!id || session.id !== id) {
    console.error("Cast session not found");
    socket.destroy();
    return;
  }

  const requestedPageId = params?.pageId || url.searchParams.get("pageId") || null;
  const requestedPageIndex = params?.pageIndex || url.searchParams.get("pageIndex") || null;
  const tabDiscoveryMode =
    url.searchParams.get("tabInfo") === "true" || (!requestedPageId && !requestedPageIndex);
  const viewport = { ...session.dimensions, isMobile: false };

  wss.handleUpgrade(request, socket, head, async (ws) => {
    let browser: Browser | null = null;
    let targetPage: Page | null = null;
    let targetClient: CDPSession | null = null;
    let targetPageId: string | null = null;
    let unsubscribeScreencast: (() => void) | null = null;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let disposed = false;
    let tabListVersion = 0;
    const activePages = new Map<string, Page>();
    const pendingPages = new Set<string>();

    const isActive = () => !disposed && ws.readyState === WebSocket.OPEN;
    const send = (message: object) => {
      if (isActive()) ws.send(JSON.stringify(message));
    };

    const cleanup = () => {
      disposed = true;
      tabListVersion++;
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
      activePages.clear();
      pendingPages.clear();
      // Keep an error listener until the socket closes, including failed setup.
      if (ws.readyState === WebSocket.CLOSED) {
        ws.off("close", onClose);
        ws.off("error", onSocketError);
      }
      ws.off("message", onMessage);

      // Clear ownership before releasing anything. Setup can finish after a close;
      // a later cleanup must still release resources acquired in that interval.
      const unsubscribe = unsubscribeScreencast;
      const client = targetClient;
      const connection = browser;
      unsubscribeScreencast = null;
      targetClient = null;
      targetPage = null;
      browser = null;

      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (error) {
          console.error("Error releasing screencast:", error);
        }
      }
      if (client) {
        void client.detach().catch((error: unknown) => {
          if (!(error instanceof Error && error.message.includes("Target closed"))) {
            console.error("Error detaching cast client:", error);
          }
        });
      }
      if (connection) {
        connection.off("disconnected", onDisconnected);
        connection.off("targetcreated", onTargetCreated);
        connection.off("targetdestroyed", onTargetDestroyed);
        void connection.disconnect().catch((error: unknown) => {
          console.error("Error disconnecting cast browser:", error);
        });
      }
    };

    const stopIfClosed = () => {
      if (isActive()) return false;
      cleanup();
      return true;
    };

    const onClose = () => {
      cleanup();
      ws.off("error", onSocketError);
    };

    const onSocketError = (error: Error) => {
      console.error("Cast WebSocket error:", error);
      cleanup();
      ws.close();
    };

    const onDisconnected = () => {
      cleanup();
      ws.close();
    };

    const sendTabList = async () => {
      if (!isActive()) return;
      const version = ++tabListVersion;
      const tabs: PageInfo[] = [];
      for (const [pageId, page] of activePages) {
        const [title, favicon] = await Promise.all([getPageTitle(page), getPageFavicon(page)]);
        if (!isActive() || version !== tabListVersion) return;
        tabs.push({ id: pageId, url: page.url(), title, favicon });
      }
      send({ type: "tabList", tabs, firstTabId: tabs[0]?.id ?? null });
    };

    const onTargetCreated = async (target: Target) => {
      if (!isActive() || target.type() !== "page") return;
      let pendingPageId: string | undefined;
      try {
        const pageId = extractTargetId(target);
        if (activePages.has(pageId) || pendingPages.has(pageId)) return;
        pendingPageId = pageId;
        pendingPages.add(pageId);
        const page = await target.asPage();
        // A target can close before Puppeteer finishes resolving its page.
        if (!isActive() || !pendingPages.delete(pageId)) return;
        activePages.set(pageId, page);
        await sendTabList();
      } catch (error) {
        if (isActive()) console.error("Error handling new cast target:", error);
      } finally {
        if (pendingPageId !== undefined) pendingPages.delete(pendingPageId);
      }
    };

    const onTargetDestroyed = async (target: Target) => {
      if (!isActive() || target.type() !== "page") return;
      try {
        const pageId = extractTargetId(target);
        pendingPages.delete(pageId);
        if (tabDiscoveryMode) {
          if (activePages.delete(pageId)) {
            send({ type: "tabClosed", pageId });
            await sendTabList();
          }
        } else if (pageId === targetPageId) {
          send({ type: "targetClosed", pageId });
          cleanup();
          ws.close();
        }
      } catch (error) {
        console.error("Error handling destroyed cast target:", error);
      }
    };

    const onMessage = async (message: RawData) => {
      if (!isActive() || !targetClient || !targetPage) return;
      const client = targetClient;
      const page = targetPage;
      try {
        const data: CastEvent = JSON.parse(message.toString());
        switch (data.type) {
          case "mouseEvent": {
            const { event } = data;
            await client.send("Input.dispatchMouseEvent", {
              type: event.type,
              x: event.x,
              y: event.y,
              button: event.button,
              buttons: event.button === "none" ? 0 : 1,
              clickCount: event.clickCount || 1,
              modifiers: event.modifiers || 0,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
            break;
          }
          case "keyEvent": {
            const { event } = data;
            await client.send("Input.dispatchKeyEvent", {
              type: event.type,
              text: event.text,
              unmodifiedText: event.text?.toLowerCase(),
              code: event.code,
              key: event.key,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode,
              modifiers: event.modifiers || 0,
              autoRepeat: false,
              isKeypad: false,
              isSystemKey: false,
            });
            break;
          }
          case "navigation":
            await navigatePage(data.event, page);
            break;
          case "closeTab":
            await page.close();
            break;
          case "getSelectedText": {
            try {
              const text = await page.evaluate(() => window.getSelection()?.toString() ?? "");
              send({ type: "selectedTextResponse", pageId: data.pageId, text });
            } catch (error) {
              console.error("Failed to get selected text:", error);
              send({
                type: "selectedTextResponse",
                pageId: data.pageId,
                text: "",
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
            break;
          }
          default:
            console.warn("Unknown cast event type");
        }
      } catch (error) {
        console.error("Error handling cast WebSocket message:", error);
      }
    };

    // Observe disconnects before the first asynchronous setup step in either mode.
    ws.once("close", onClose);
    ws.on("error", onSocketError);

    try {
      if (stopIfClosed()) return;
      browser = await puppeteer.connect({ browserWSEndpoint: browserSession.getEndpoint() });
      if (stopIfClosed()) return;
      browser.once("disconnected", onDisconnected);

      const pages = await browser.pages();
      if (stopIfClosed()) return;

      if (tabDiscoveryMode) {
        for (const page of pages) activePages.set(extractTargetId(page.target()), page);
        browser.on("targetcreated", onTargetCreated);
        browser.on("targetdestroyed", onTargetDestroyed);
        await sendTabList();
      } else {
        targetPage = findTargetPage(pages, requestedPageId, requestedPageIndex) ?? null;
        if (!targetPage) {
          console.error("Requested cast page not found");
          cleanup();
          socket.destroy();
          return;
        }
        targetPageId = extractTargetId(targetPage.target());
        browser.on("targetdestroyed", onTargetDestroyed);

        await targetPage.bringToFront();
        if (stopIfClosed()) return;
        targetClient = await targetPage.target().createCDPSession();
        if (stopIfClosed()) return;

        const format: CastFormat = url.searchParams.get("format") === "binary" ? "binary" : "json";
        unsubscribeScreencast = await subscribeToScreencast(
          targetPageId,
          viewport,
          ws,
          format,
          targetPage,
        );
        if (stopIfClosed()) return;
        ws.on("message", onMessage);
      }

      if (stopIfClosed()) return;
      heartbeatInterval = setInterval(() => {
        if (stopIfClosed()) return;
        try {
          ws.ping();
        } catch (error) {
          console.error("Error sending cast ping:", error);
          cleanup();
          ws.close();
        }
      }, 30_000);
    } catch (error) {
      if (isActive()) console.error("Error in cast session:", error);
      cleanup();
      socket.destroy();
    }
  });
}
