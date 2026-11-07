export function titleCase(input: string): string {
  if (!input || typeof input !== "string") {
    return "";
  }
  return input.charAt(0).toUpperCase() + input.slice(1);
}

// Page masked text by Unicode code point without copying the whole document.
// Callers choose their output field; offsets refer to the complete source text.
export const DEFAULT_TEXT_LIMIT = 20_000;
export const MAX_TEXT_LIMIT = 100_000;

export interface TextRange {
  offset?: number;
  limit?: number;
}

export function textPage(value: string, range: TextRange = {}) {
  const requestedOffset = range.offset ?? 0;
  const limit = range.limit ?? DEFAULT_TEXT_LIMIT;
  let total = 0;
  let position = 0;
  let start = value.length;
  let end = value.length;
  for (const character of value) {
    if (total === requestedOffset) start = position;
    if (total === requestedOffset + limit) end = position;
    position += character.length;
    total++;
  }
  const offset = Math.min(requestedOffset, total);
  const nextOffset = Math.min(offset + limit, total);
  return {
    value: value.slice(start, end),
    offset,
    total,
    ...(nextOffset < total ? { nextOffset } : {}),
  };
}
