import { Page } from "puppeteer-core";
import {
  IndexedDBDatabase,
  SessionStorageData,
  LocalStorageData,
} from "../services/context/types.js";
import type { BrowserLauncherOptions } from "../types/browser.js";

export const injectStorageOnNewDocument = async (
  page: Page,
  storageByOrigin: Map<
    string,
    {
      localStorage?: LocalStorageData;
      sessionStorage?: SessionStorageData;
      indexedDB?: IndexedDBDatabase[];
    }
  >,
) => {
  const storage: Record<
    string,
    { localStorage?: LocalStorageData; sessionStorage?: SessionStorageData }
  > = {};
  for (const [origin, { localStorage, sessionStorage }] of storageByOrigin) {
    if (localStorage || sessionStorage) {
      storage[origin] = { localStorage, sessionStorage };
    }
  }
  if (Object.keys(storage).length === 0) return;

  await page.evaluateOnNewDocument((storage) => {
    if (window.top !== window) return;
    const items = storage[location.origin];
    if (!items) return;
    for (const [area, values] of [
      ["localStorage", items.localStorage],
      ["sessionStorage", items.sessionStorage],
    ] as const) {
      for (const [key, value] of Object.entries(values ?? {})) {
        try {
          if (typeof value === "string") {
            window[area].setItem(key, value);
          }
        } catch (e) {
          console.error(`Error setting ${area}: ${e}`);
        }
      }
    }
  }, storage);
};

/**
 * Organizes session storage data by origin for efficient lookup
 * @param context Session context data from BrowserLauncherOptions
 * @returns Map of origins to their storage data
 */
export function groupSessionStorageByOrigin(
  context?: BrowserLauncherOptions["sessionContext"],
): Map<
  string,
  {
    localStorage?: LocalStorageData;
    sessionStorage?: SessionStorageData;
    indexedDB?: IndexedDBDatabase[];
  }
> {
  const result = new Map<
    string,
    {
      localStorage?: LocalStorageData;
      sessionStorage?: SessionStorageData;
      indexedDB?: IndexedDBDatabase[];
    }
  >();

  if (!context) return result;

  if (context.localStorage) {
    for (const [domain, storage] of Object.entries(context.localStorage)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.localStorage = storage;
    }
  }

  if (context.sessionStorage) {
    for (const [domain, storage] of Object.entries(context.sessionStorage)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.sessionStorage = storage;
    }
  }

  if (context.indexedDB) {
    for (const [domain, databases] of Object.entries(context.indexedDB)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.indexedDB = databases;
    }
  }

  return result;
}

/**
 * Deep merge two objects, with the second object taking precedence.
 * Arrays are replaced entirely, not merged.
 */
export function deepMerge<T = any>(target: T, source: Partial<T>): T {
  if (typeof target !== "object" || target === null) {
    return source as T;
  }
  if (typeof source !== "object" || source === null) {
    return target;
  }

  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      const sourceValue = source[key];
      const targetValue = (result as any)[key];

      if (typeof sourceValue === "object" && sourceValue !== null && !Array.isArray(sourceValue)) {
        (result as any)[key] = deepMerge(targetValue, sourceValue);
      } else {
        (result as any)[key] = sourceValue;
      }
    }
  }

  return result;
}
