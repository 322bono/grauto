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

const NOTICE_PATTERNS = [
  /무단\s*전재/,
  /재배포는?\s*금지/,
  /금지됩니다/,
  /전국연합학력평가/,
  /교육청\s*주관/,
  /EBSi/,
  /해당\s*자료/,
  /제공됩니다/,
];

export function stripNoticeText(value: string | null | undefined) {
  const normalized = normalizeReadableText(value ?? "", "");

  if (!normalized) {
    return "";
  }

  const segments = normalized
    .split(/(?<=[.!?。]|다\.)\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const filteredSegments = segments.filter((segment) => !NOTICE_PATTERNS.some((pattern) => pattern.test(segment)));

  if (filteredSegments.length > 0) {
    const cleaned = filteredSegments
      .join(" ")
      .replace(/^\d+[.)]?\s*/, "")
      .trim();

    return /^[\d.)\s]+$/.test(cleaned) ? "" : cleaned;
  }

  if (NOTICE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "";
  }

  return normalized;
}
