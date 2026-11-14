const MOJIBAKE_PATTERN = /Ã|Ä|Æ|Â|áº|á»|€|�/;

export function normalizeVietnameseText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!MOJIBAKE_PATTERN.test(text)) return text;

  try {
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return MOJIBAKE_PATTERN.test(decoded) ? text : decoded;
  } catch {
    return text;
  }
}

export function normalizeVietnameseFields<T extends Record<string, any>>(
  row: T,
  fields: Array<keyof T>
): T {
  return fields.reduce((next, field) => {
    const value = next[field];
    return {
      ...next,
      [field]: typeof value === "string" ? normalizeVietnameseText(value) : value,
    };
  }, row);
}
