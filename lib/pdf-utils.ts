"use client";

import { pdfjs } from "react-pdf";
import { buildPdfDocumentInit } from "@/lib/pdf-config";
import { ensurePdfWorker } from "@/lib/pdf-worker";
import { normalizeReadableText } from "@/lib/text-quality";
import type { NormalizedRect, PageNumberAnchor } from "@/lib/types";

ensurePdfWorker();

const CIRCLED_NUMBER_MAP = new Map<string, number>([
  ["①", 1],
  ["②", 2],
  ["③", 3],
  ["④", 4],
  ["⑤", 5],
  ["⑥", 6],
  ["⑦", 7],
  ["⑧", 8],
  ["⑨", 9],
  ["⑩", 10],
  ["⑪", 11],
  ["⑫", 12],
  ["⑬", 13],
  ["⑭", 14],
  ["⑮", 15],
  ["⑯", 16],
  ["⑰", 17],
  ["⑱", 18],
  ["⑲", 19],
  ["⑳", 20]
]);

interface DetectedQuestionRegion {
  questionNumber: number | null;
  bounds: NormalizedRect;
  textSnippet: string;
}

interface PositionedTextFragment {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface QuestionAnchorCandidate {
  questionNumber: number;
  text: string;
  left: number;
  top: number;
  lineText: string;
}

interface ColumnBand {
  id: string;
  left: number;
  right: number;
  center: number;
}

export function clonePdfBytes(source: Uint8Array) {
  return new Uint8Array(source.slice());
}

function toPdfData(source: File | ArrayBuffer | Uint8Array) {
  if (source instanceof Uint8Array) {
    return clonePdfBytes(source);
  }

  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(0));
  }

  return source.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export async function extractPdfTextSnippets(source: File | ArrayBuffer | Uint8Array) {
  const data = await toPdfData(source);
  const document = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise;
  const snippets: Record<number, string> = {};

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    snippets[pageNumber] = normalizeReadableText(text.slice(0, 180));
  }

  return snippets;
}

export async function extractPdfQuestionRegions(source: File | ArrayBuffer | Uint8Array) {
  const data = await toPdfData(source);
  const document = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise;
  const regionsByPage: Record<number, DetectedQuestionRegion[]> = {};

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const fragments = textContent.items.flatMap((item) => toPositionedFragments(item, viewport.width, viewport.height));
    regionsByPage[pageNumber] = buildQuestionRegionsFromFragments(fragments);
  }

  return regionsByPage;
}

export async function extractPdfAnswerRegions(source: File | ArrayBuffer | Uint8Array) {
  const data = await toPdfData(source);
  const document = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise;
  const regionsByPage: Record<number, PageNumberAnchor[]> = {};

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const fragments = textContent.items.flatMap((item) => toPositionedFragments(item, viewport.width, viewport.height));
    regionsByPage[pageNumber] = buildAnswerRegionsFromFragments(fragments);
  }

  return regionsByPage;
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number, width: number, height: number) {
  const left = Math.max(0, Math.min(startX, endX));
  const top = Math.max(0, Math.min(startY, endY));
  const right = Math.min(width, Math.max(startX, endX));
  const bottom = Math.min(height, Math.max(startY, endY));

  return {
    x: left / width,
    y: top / height,
    width: Math.max(0, right - left) / width,
    height: Math.max(0, bottom - top) / height
  };
}

export function denormalizeRect(rect: NormalizedRect, width: number, height: number) {
  return {
    left: rect.x * width,
    top: rect.y * height,
    width: rect.width * width,
    height: rect.height * height
  };
}

export function cropCanvasToDataUrl(sourceCanvas: HTMLCanvasElement, rect: NormalizedRect) {
  const actual = denormalizeRect(rect, sourceCanvas.width, sourceCanvas.height);
  const cropX = Math.max(0, actual.left);
  const cropY = Math.max(0, actual.top);
  const cropWidth = Math.max(16, actual.width);
  const cropHeight = Math.max(16, actual.height);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropWidth);
  canvas.height = Math.round(cropHeight);
  const context = canvas.getContext("2d");

  if (!context) {
    return "";
  }

  context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function cropCanvasToCompressedDataUrl(
  sourceCanvas: HTMLCanvasElement,
  rect: NormalizedRect,
  options?: {
    maxWidth?: number;
    mimeType?: "image/jpeg" | "image/png";
    quality?: number;
  }
) {
  const actual = denormalizeRect(rect, sourceCanvas.width, sourceCanvas.height);
  const cropX = Math.max(0, Math.round(actual.left));
  const cropY = Math.max(0, Math.round(actual.top));
  const cropWidth = Math.max(24, Math.round(actual.width));
  const cropHeight = Math.max(24, Math.round(actual.height));

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const context = canvas.getContext("2d");

  if (!context) {
    return "";
  }

  context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return canvasToCompressedDataUrl(canvas, options);
}

export function canvasToCompressedDataUrl(
  sourceCanvas: HTMLCanvasElement,
  options?: {
    maxWidth?: number;
    mimeType?: "image/jpeg" | "image/png";
    quality?: number;
  }
) {
  const maxWidth = options?.maxWidth ?? sourceCanvas.width;
  const mimeType = options?.mimeType ?? "image/jpeg";
  const quality = options?.quality ?? 0.74;
  const scale = Math.min(1, maxWidth / Math.max(1, sourceCanvas.width));
  const targetWidth = Math.max(24, Math.round(sourceCanvas.width * scale));
  const targetHeight = Math.max(24, Math.round(sourceCanvas.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return "";
  }

  context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, targetWidth, targetHeight);
  return mimeType === "image/png" ? canvas.toDataURL(mimeType) : canvas.toDataURL(mimeType, quality);
}

export function renderCropStyle(rect: NormalizedRect) {
  return {
    img: {
      width: `${100 / rect.width}%`,
      height: `${100 / rect.height}%`,
      transform: `translate(${-rect.x * 100}%, ${-rect.y * 100}%)`,
      transformOrigin: "top left"
    }
  } as const;
}

export function clampBoundingBox(box: NormalizedRect | null): NormalizedRect | null {
  if (!box) {
    return null;
  }

  const x = Math.min(0.96, Math.max(0, box.x));
  const y = Math.min(0.96, Math.max(0, box.y));
  const width = Math.min(1 - x, Math.max(0.04, box.width));
  const height = Math.min(1 - y, Math.max(0.04, box.height));

  return { x, y, width, height };
}

export function detectQuestionBandsFromCanvas(sourceCanvas: HTMLCanvasElement) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const left = Math.max(0, Math.round(width * 0.04));
  const top = Math.max(0, Math.round(height * 0.05));
  const cropWidth = Math.max(24, Math.round(width * 0.92));
  const cropHeight = Math.max(24, Math.round(height * 0.9));
  const context = sourceCanvas.getContext("2d");

  if (!context) {
    return [] as NormalizedRect[];
  }

  const { data } = context.getImageData(left, top, cropWidth, cropHeight);
  const rowActivity: boolean[] = [];
  const xStep = Math.max(4, Math.round(cropWidth / 120));
  const minActiveRatio = 0.012;

  for (let y = 0; y < cropHeight; y += 1) {
    let darkPixels = 0;
    let sampledPixels = 0;

    for (let x = 0; x < cropWidth; x += xStep) {
      const index = (y * cropWidth + x) * 4;
      const luminance = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
      sampledPixels += 1;

      if (luminance < 232) {
        darkPixels += 1;
      }
    }

    rowActivity.push(sampledPixels > 0 && darkPixels / sampledPixels >= minActiveRatio);
  }

  const segments: Array<{ start: number; end: number }> = [];
  let segmentStart: number | null = null;

  rowActivity.forEach((isActive, rowIndex) => {
    if (isActive && segmentStart === null) {
      segmentStart = rowIndex;
      return;
    }

    if (!isActive && segmentStart !== null) {
      segments.push({ start: segmentStart, end: rowIndex - 1 });
      segmentStart = null;
    }
  });

  if (segmentStart !== null) {
    segments.push({ start: segmentStart, end: rowActivity.length - 1 });
  }

  const minGap = Math.max(18, Math.round(cropHeight * 0.018));
  const mergedSegments = segments.reduce<Array<{ start: number; end: number }>>((current, segment) => {
    const previous = current[current.length - 1];

    if (previous && segment.start - previous.end <= minGap) {
      previous.end = segment.end;
      return current;
    }

    current.push({ ...segment });
    return current;
  }, []);

  const minHeight = Math.max(42, Math.round(cropHeight * 0.06));

  return mergedSegments
    .filter((segment) => segment.end - segment.start >= minHeight)
    .slice(0, 12)
    .map((segment, index, allSegments) => {
      const nextSegment = allSegments[index + 1];
      const start = Math.max(0, segment.start - 12);
      const fallbackBottom = Math.min(cropHeight - 1, segment.end + Math.max(48, Math.round(cropHeight * 0.22)));
      const nextBottom = nextSegment ? Math.max(segment.end + 12, nextSegment.start - 10) : fallbackBottom;
      const end = Math.min(cropHeight - 1, Math.max(fallbackBottom, nextBottom));

      return {
        x: left / width,
        y: (top + start) / height,
        width: cropWidth / width,
        height: Math.min(height - top, end - start) / height
      };
    })
    .map((box) => clampBoundingBox(box))
    .filter((box): box is NormalizedRect => Boolean(box));
}

function toPositionedFragments(item: unknown, viewportWidth: number, viewportHeight: number): PositionedTextFragment[] {
  if (!item || typeof item !== "object" || !("str" in item)) {
    return [];
  }

  const candidate = item as {
    str?: unknown;
    transform?: unknown;
    width?: unknown;
    height?: unknown;
  };
  const rawText = typeof candidate.str === "string" ? candidate.str.replace(/\s+/g, " ").trim() : "";

  if (!rawText) {
    return [];
  }

  const transform = Array.isArray(candidate.transform) ? candidate.transform : [];
  const x = typeof transform[4] === "number" ? transform[4] : 0;
  const baselineY = typeof transform[5] === "number" ? transform[5] : 0;
  const rawWidth = typeof candidate.width === "number" ? candidate.width : Math.max(12, rawText.length * 8);
  const rawHeight =
    typeof candidate.height === "number" && candidate.height > 0
      ? candidate.height
      : Math.max(10, Math.abs(typeof transform[3] === "number" ? transform[3] : 12));
  const top = clamp01((viewportHeight - baselineY - rawHeight) / Math.max(1, viewportHeight));
  const left = clamp01(x / Math.max(1, viewportWidth));
  const right = clamp01((x + rawWidth) / Math.max(1, viewportWidth));
  const bottom = clamp01((viewportHeight - baselineY + rawHeight * 0.2) / Math.max(1, viewportHeight));

  return [
    {
      text: rawText,
      left,
      top,
      right,
      bottom
    }
  ];
}

function buildQuestionRegionsFromFragments(fragments: PositionedTextFragment[]) {
  const anchors = detectQuestionAnchors(fragments);
  const dedupedAnchors = keepUniqueQuestionAnchors(dedupeQuestionAnchors(anchors));

  if (dedupedAnchors.length === 0) {
    return [] as DetectedQuestionRegion[];
  }

  const columns = inferColumnBands(dedupedAnchors);
  const orderedColumns = [...columns].sort((left, right) => left.left - right.left);
  const regions = orderedColumns.flatMap((column) => {
    const columnAnchors = dedupedAnchors
      .filter((anchor) => resolveAnchorColumn(anchor, orderedColumns).id === column.id)
      .sort((left, right) => left.top - right.top)
      .slice(0, 20);

    return columnAnchors.map((anchor, index) => {
      const nextAnchor = columnAnchors[index + 1];
      const startY = Math.max(0.04, anchor.top - 0.018);
      const endY = nextAnchor ? Math.min(0.94, Math.max(startY + 0.16, nextAnchor.top - 0.018)) : 0.94;
      const horizontalPadding = orderedColumns.length > 1 ? 0.008 : 0.01;
      const x = Math.max(0.02, column.left - horizontalPadding);
      const right = Math.min(0.98, column.right + horizontalPadding);
      const bounds = clampBoundingBox({
        x,
        y: startY,
        width: right - x,
        height: endY - startY
      });

      const textSnippet = fragments
        .filter((fragment) => fragment.left <= right + 0.01 && fragment.right >= x - 0.01)
        .filter((fragment) => fragment.top >= startY - 0.01 && fragment.bottom <= endY + 0.015)
        .map((fragment) => fragment.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);

      return {
        questionNumber: anchor.questionNumber,
        bounds: bounds ?? { x, y: startY, width: Math.max(0.16, right - x), height: Math.max(0.08, endY - startY) },
        textSnippet: normalizeReadableText(textSnippet)
      };
    });
  });

  return regions.slice(0, 24);
}

function buildAnswerRegionsFromFragments(fragments: PositionedTextFragment[]) {
  const anchors = keepUniqueQuestionAnchors(dedupeQuestionAnchors(detectQuestionAnchors(fragments)));

  if (anchors.length === 0) {
    return [] as PageNumberAnchor[];
  }

  const columns = inferColumnBands(anchors);

  return anchors.slice(0, 40).map((anchor) => {
    const column = resolveAnchorColumn(anchor, columns);
    const nextAnchor = anchors
      .filter((candidate) => candidate.questionNumber !== anchor.questionNumber)
      .filter((candidate) => resolveAnchorColumn(candidate, columns).id === column.id)
      .filter((candidate) => candidate.top > anchor.top + 0.01)
      .sort((left, right) => left.top - right.top)[0];
    const top = clamp01(anchor.top - 0.014);
    const bottom = nextAnchor ? clamp01(nextAnchor.top - 0.016) : 0.972;
    const safeBottom = bottom <= top + 0.08 ? Math.min(0.972, top + 0.22) : bottom;
    const bounds = clampBoundingBox({
      x: column.left,
      y: top,
      width: column.right - column.left,
      height: safeBottom - top
    });
    const textSnippet = fragments
      .filter((fragment) => fragment.left <= column.right + 0.01 && fragment.right >= column.left - 0.01)
      .filter((fragment) => fragment.top >= top - 0.01 && fragment.bottom <= safeBottom + 0.012)
      .map((fragment) => fragment.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);

    return {
      questionNumber: anchor.questionNumber,
      bounds: bounds ?? {
        x: column.left,
        y: top,
        width: Math.max(0.18, column.right - column.left),
        height: Math.max(0.12, safeBottom - top)
      },
      textSnippet: normalizeReadableText(textSnippet)
    } satisfies PageNumberAnchor;
  });
}

function detectQuestionAnchors(fragments: PositionedTextFragment[]) {
  return fragments
    .map((fragment) => ({
      questionNumber: parseQuestionNumber(fragment.text),
      text: fragment.text,
      left: fragment.left,
      top: fragment.top,
      lineText: buildLineText(fragment, fragments)
    }))
    .filter(
      (anchor): anchor is QuestionAnchorCandidate =>
        anchor.questionNumber !== null &&
        anchor.top >= 0.04 &&
        anchor.top <= 0.965 &&
        !isHeaderLikeAnchor(anchor) &&
        !isChoiceLikeAnchor(anchor)
    )
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

function dedupeQuestionAnchors(anchors: QuestionAnchorCandidate[]) {
  return anchors.reduce<Array<{ questionNumber: number; left: number; top: number }>>((current, anchor) => {
    const previous = current[current.length - 1];

    if (previous && Math.abs(previous.top - anchor.top) < 0.025 && Math.abs(previous.left - anchor.left) < 0.08) {
      if (anchor.left < previous.left) {
        previous.left = anchor.left;
        previous.questionNumber = anchor.questionNumber;
      }

      return current;
    }

    current.push({ ...anchor });
    return current;
  }, []);
}

function keepUniqueQuestionAnchors(anchors: Array<{ questionNumber: number; left: number; top: number }>) {
  const seen = new Set<number>();

  return anchors.filter((anchor) => {
    if (seen.has(anchor.questionNumber)) {
      return false;
    }

    seen.add(anchor.questionNumber);
    return true;
  });
}

function inferColumnBands(anchors: Array<{ questionNumber: number; left: number; top: number }>) {
  if (anchors.length === 0) {
    return [{ id: "col-1", left: 0.04, right: 0.96, center: 0.5 }] satisfies ColumnBand[];
  }

  const groups = anchors
    .slice()
    .sort((left, right) => left.left - right.left)
    .reduce<Array<Array<{ questionNumber: number; left: number; top: number }>>>((current, anchor) => {
      const previous = current[current.length - 1];

      if (!previous) {
        current.push([anchor]);
        return current;
      }

      const previousCenter = average(previous.map((item) => item.left));

      if (Math.abs(anchor.left - previousCenter) <= 0.14) {
        previous.push(anchor);
        return current;
      }

      current.push([anchor]);
      return current;
    }, []);

  const sortedGroups = groups
    .map((group, index) => ({
      id: `col-${index + 1}`,
      center: average(group.map((item) => item.left))
    }))
    .sort((left, right) => left.center - right.center);

  return sortedGroups.map((group, index) => {
    const previous = sortedGroups[index - 1];
    const next = sortedGroups[index + 1];
    const left = previous ? clamp01((previous.center + group.center) / 2 - 0.03) : 0.03;
    const right = next ? clamp01((group.center + next.center) / 2 + 0.05) : 0.97;

    return {
      id: group.id,
      left,
      right: Math.max(left + 0.18, right),
      center: group.center
    } satisfies ColumnBand;
  });
}

function resolveAnchorColumn(anchor: { left: number }, columns: ColumnBand[]) {
  return [...columns].sort((left, right) => Math.abs(anchor.left - left.center) - Math.abs(anchor.left - right.center))[0];
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function buildLineText(target: PositionedTextFragment, fragments: PositionedTextFragment[]) {
  return fragments
    .filter((fragment) => Math.abs(fragment.top - target.top) <= 0.02)
    .sort((left, right) => left.left - right.left)
    .map((fragment) => fragment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeaderLikeAnchor(anchor: { questionNumber: number | null; text: string; left: number; top: number; lineText: string }) {
  const compactLine = anchor.lineText.replace(/\s+/g, "");

  if (anchor.top <= 0.16 && /제\d+교시/.test(compactLine)) {
    return true;
  }

  if (
    anchor.top <= 0.16 &&
    /(교시|영역|모의고사|소단원|중단원|점검|테스트|과목)/.test(anchor.lineText)
  ) {
    return true;
  }

  if (anchor.top <= 0.1 && anchor.text === String(anchor.questionNumber)) {
    return true;
  }

  return false;
}

function isChoiceLikeAnchor(anchor: { questionNumber: number | null; text: string; left: number; top: number; lineText: string }) {
  const choiceMarkerCount = countChoiceMarkers(anchor.lineText);
  const text = anchor.text.replace(/\s+/g, "");

  if (isCircledChoice(text)) {
    return true;
  }

  if (choiceMarkerCount >= 3) {
    return true;
  }

  if (choiceMarkerCount >= 2 && anchor.left > 0.12) {
    return true;
  }

  return false;
}

function parseQuestionNumber(text: string) {
  const compact = text.replace(/\s+/g, "");

  if (CIRCLED_NUMBER_MAP.has(compact)) {
    return CIRCLED_NUMBER_MAP.get(compact) ?? null;
  }

  const match = compact.match(/^(\d{1,3})(?:[.)]|번)?$/);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value <= 200 ? value : null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function isCircledChoice(text: string) {
  return /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/.test(text);
}

function countChoiceMarkers(text: string) {
  const matches = text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|(?:^|[\s(])(?:1|2|3|4|5)(?:[.)]|(?=\s))/gu);
  return matches?.length ?? 0;
}
