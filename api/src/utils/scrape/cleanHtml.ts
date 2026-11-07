import { load } from "cheerio";

export const cleanHtml = (html: string): string => {
  const blacklistedElements = new Set([
    "head",
    "title",
    "meta",
    "script",
    "style",
    "path",
    "svg",
    "br",
    "hr",
    "link",
    "object",
    "embed",
  ]);

  const blacklistedAttributes = [
    "style",
    "ping",
    "src",
    "item.*",
    "aria.*",
    "js.*",
    "data-.*",
    "role",
    "tabindex",
    "onerror",
  ];

  const $ = load(html, { scriptingEnabled: false });

  // Remove blacklisted elements
  blacklistedElements.forEach((tag) => {
    $(tag).remove();
  });

  // Remove blacklisted attributes
  const elements = $("*");
  elements.each((_index, element) => {
    blacklistedAttributes.forEach((attrPattern) => {
      const regex = new RegExp(`^${attrPattern}$`);
      Object.keys($(element).attr() ?? {}).forEach((name) => {
        if (regex.test(name)) {
          $(element).removeAttr(name);
        }
      });
    });
  });

  // Remove empty elements
  elements.each((_index, element) => {
    if (
      !Object.keys($(element).attr() ?? {}).length &&
      $(element).prop("textContent")?.trim() === ""
    ) {
      $(element).remove();
    }
  });

  return $("html").toString();
};
