export function looksUnreadableText(value: string | null | undefined) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return true;
  }

  const replacementCount = (normalized.match(/[�□]/g) ?? []).length;
  const readableCount = (normalized.match(/[0-9A-Za-z가-힣]/g) ?? []).length;
  const symbolRatio = replacementCount / Math.max(1, normalized.length);
  const readableRatio = readableCount / Math.max(1, normalized.length);

  if (replacementCount >= 3) {
    return true;
  }

  if (symbolRatio >= 0.08) {
    return true;
  }

  if (normalized.length >= 12 && readableRatio < 0.35) {
    return true;
  }

  return false;
}

export function normalizeReadableText(value: string | null | undefined, fallback = "") {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();

  if (!normalized || looksUnreadableText(normalized)) {
    return fallback;
  }

  return normalized;
}
