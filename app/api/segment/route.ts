import { NextResponse } from "next/server";
import { generateGeminiJson, imagePartFromDataUrl, type GeminiPart } from "@/lib/gemini";
import type {
  NormalizedRect,
  SegmentRequestPayload,
  SegmentResponsePayload,
  SegmentedAnswerAnchor,
  SegmentedQuestionRegion,
} from "@/lib/types";

export const runtime = "nodejs";

const QUESTION_REGION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question_number", "bounds", "text_snippet"],
  properties: {
    question_number: {
      anyOf: [{ type: "number" }, { type: "null" }],
    },
    bounds: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    text_snippet: { type: "string" },
  },
} as const;

const ANSWER_ANCHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question_number", "bounds", "text_snippet", "segments"],
  properties: {
    question_number: {
      anyOf: [{ type: "number" }, { type: "null" }],
    },
    bounds: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
    text_snippet: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "width", "height"],
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
    },
  },
} as const;

const QUESTION_SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page_number", "question_regions"],
        properties: {
          page_number: { type: "number" },
          question_regions: {
            type: "array",
            items: QUESTION_REGION_SCHEMA,
          },
        },
      },
    },
  },
} as const;

const ANSWER_SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page_number", "answer_anchors"],
        properties: {
          page_number: { type: "number" },
          answer_anchors: {
            type: "array",
            items: ANSWER_ANCHOR_SCHEMA,
          },
        },
      },
    },
  },
} as const;

const QUESTION_SEGMENT_PROMPT = `
You receive multiple scanned exam question pages in a single request.
Return JSON only.

Task:
- For each input page, detect every real question block on that page.
- Each block must contain exactly one question stem and its related choices or answer area.
- Ignore page headers, section headers, page numbers, score labels, and isolated answer choices.
- Do not merge two different questions into one block.
- If the page has multiple columns, still separate each question correctly.

Output rules:
- Return one page entry for every provided page_number.
- page_number must exactly match the input page_number for that image.
- question_number should be the visible problem number when readable, otherwise null.
- bounds must be normalized 0..1.
- bounds must be tight and must not include neighboring questions.
- Always include the full visible question number, the full stem line, and the full choice row width.
- Do not cut off the left or right edge of the question content.
- Sort question_regions by real question number when visible. Otherwise use reading order.
`;

const ANSWER_SEGMENT_PROMPT = `
You receive multiple scanned answer or explanation pages in a single request.
Return JSON only.

Task:
- For each input page, detect each question's explanation block on that page.
- Each returned item must belong to one question number only.
- Do not return the whole page for one question.
- If one question's explanation continues in another column or another vertical segment on the same page, include all pieces in segments.

Output rules:
- Return one page entry for every provided page_number.
- page_number must exactly match the input page_number for that image.
- question_number should be the visible question number when readable, otherwise null.
- bounds must cover the overall explanation area for that question on the current page.
- segments must contain one or more tight normalized boxes in reading order.
- Ignore page headers, section headers, and unrelated questions.
- Do not merge two different question numbers into one item.
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as SegmentRequestPayload;

  if (!payload.pages?.length) {
    return new NextResponse("No pages were provided for segmentation.", { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return new NextResponse("GEMINI_API_KEY is missing.", { status: 500 });
  }

  try {
    const pages =
      payload.mode === "questions"
        ? await segmentQuestionPages(apiKey, model, payload.pages)
        : await segmentAnswerPages(apiKey, model, payload.pages);

    return NextResponse.json({
      mode: payload.mode,
      pages,
    } satisfies SegmentResponsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Segmentation failed.";

    if (isQuotaError(message)) {
      return new NextResponse("Gemini 무료 등급 분당 요청 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.", {
        status: 429,
      });
    }

    return new NextResponse(message, { status: 500 });
  }
}

async function segmentQuestionPages(
  apiKey: string,
  model: string,
  pages: SegmentRequestPayload["pages"]
) {
  const parsed = await generateGeminiJson<{
    pages?: Array<{
      page_number?: number;
      question_regions?: Array<{
        question_number?: number | null;
        bounds?: NormalizedRect;
        text_snippet?: string;
      }>;
    }>;
  }>({
    apiKey,
    model,
    systemInstruction: QUESTION_SEGMENT_PROMPT,
    parts: buildBatchParts("questions", pages),
    responseJsonSchema: QUESTION_SEGMENT_SCHEMA,
    maxOutputTokens: Math.min(3600, 1200 + pages.length * 320),
    temperature: 0,
  });

  return normalizeQuestionPageResults(parsed.pages, pages);
}

async function segmentAnswerPages(
  apiKey: string,
  model: string,
  pages: SegmentRequestPayload["pages"]
) {
  const parsed = await generateGeminiJson<{
    pages?: Array<{
      page_number?: number;
      answer_anchors?: Array<{
        question_number?: number | null;
        bounds?: NormalizedRect;
        text_snippet?: string;
        segments?: NormalizedRect[];
      }>;
    }>;
  }>({
    apiKey,
    model,
    systemInstruction: ANSWER_SEGMENT_PROMPT,
    parts: buildBatchParts("answers", pages),
    responseJsonSchema: ANSWER_SEGMENT_SCHEMA,
    maxOutputTokens: Math.min(4200, 1500 + pages.length * 360),
    temperature: 0,
  });

  return normalizeAnswerPageResults(parsed.pages, pages);
}

function buildBatchParts(
  mode: "questions" | "answers",
  pages: SegmentRequestPayload["pages"]
): GeminiPart[] {
  const parts: GeminiPart[] = [
    {
      text: `mode=${mode}\npage_count=${pages.length}\nReturn one result object for every page_number exactly once.`,
    },
  ];

  for (const page of pages) {
    parts.push({
      text: [
        `page_number=${page.pageNumber}`,
        `page_text_hint=${page.textSnippet || "none"}`,
      ].join("\n"),
    });
    parts.push(imagePartFromDataUrl(page.pageImageDataUrl));
  }

  return parts;
}

function normalizeQuestionPageResults(
  value: unknown,
  requestedPages: SegmentRequestPayload["pages"]
) {
  const pageMap = new Map<number, SegmentedQuestionRegion[]>(
    requestedPages.map((page) => [page.pageNumber, []])
  );

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as {
      page_number?: number;
      question_regions?: unknown;
    };
    const pageNumber =
      typeof candidate.page_number === "number" && Number.isFinite(candidate.page_number)
        ? candidate.page_number
        : null;

    if (!pageNumber || !pageMap.has(pageNumber)) {
      continue;
    }

    pageMap.set(pageNumber, normalizeQuestionRegions(candidate.question_regions));
  }

  return requestedPages.map((page) => ({
    pageNumber: page.pageNumber,
    questionRegions: pageMap.get(page.pageNumber) ?? [],
  }));
}

function normalizeAnswerPageResults(
  value: unknown,
  requestedPages: SegmentRequestPayload["pages"]
) {
  const pageMap = new Map<number, SegmentedAnswerAnchor[]>(
    requestedPages.map((page) => [page.pageNumber, []])
  );

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as {
      page_number?: number;
      answer_anchors?: unknown;
    };
    const pageNumber =
      typeof candidate.page_number === "number" && Number.isFinite(candidate.page_number)
        ? candidate.page_number
        : null;

    if (!pageNumber || !pageMap.has(pageNumber)) {
      continue;
    }

    pageMap.set(pageNumber, normalizeAnswerAnchors(candidate.answer_anchors));
  }

  return requestedPages.map((page) => ({
    pageNumber: page.pageNumber,
    answerAnchors: pageMap.get(page.pageNumber) ?? [],
  }));
}

function normalizeQuestionRegions(value: unknown) {
  const seen = new Set<string>();
  const regions: SegmentedQuestionRegion[] = [];

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as {
      question_number?: number | null;
      bounds?: NormalizedRect;
      text_snippet?: string;
    };
    const bounds = normalizeRect(candidate.bounds);

    if (!bounds) {
      continue;
    }

    const questionNumber =
      typeof candidate.question_number === "number" && Number.isFinite(candidate.question_number)
        ? candidate.question_number
        : null;
    const key = `${questionNumber ?? "null"}:${bounds.x.toFixed(3)}:${bounds.y.toFixed(3)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    regions.push({
      questionNumber,
      bounds,
      textSnippet: typeof candidate.text_snippet === "string" ? candidate.text_snippet.trim() : "",
    });
  }

  const sorted = regions.sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });

  return postProcessQuestionRegions(dedupeQuestionRegions(sorted));
}

function normalizeAnswerAnchors(value: unknown) {
  const seen = new Set<string>();
  const anchors: SegmentedAnswerAnchor[] = [];

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as {
      question_number?: number | null;
      bounds?: NormalizedRect;
      text_snippet?: string;
      segments?: NormalizedRect[];
    };
    const bounds = normalizeRect(candidate.bounds);

    if (!bounds) {
      continue;
    }

    const questionNumber =
      typeof candidate.question_number === "number" && Number.isFinite(candidate.question_number)
        ? candidate.question_number
        : null;
    const key = `${questionNumber ?? "null"}:${bounds.x.toFixed(3)}:${bounds.y.toFixed(3)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const segments: NormalizedRect[] = [];

    for (const segment of Array.isArray(candidate.segments) ? candidate.segments : []) {
      const normalizedSegment = normalizeRect(segment);

      if (normalizedSegment) {
        segments.push(normalizedSegment);
      }
    }

    segments.sort((left, right) => left.y - right.y || left.x - right.x);

    anchors.push({
      questionNumber,
      bounds,
      textSnippet: typeof candidate.text_snippet === "string" ? candidate.text_snippet.trim() : "",
      segments: segments.length > 0 ? segments : [bounds],
    });
  }

  const sorted = anchors.sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });

  return dedupeAnswerAnchors(sorted);
}

function normalizeRect(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<NormalizedRect>;
  const x = clampNumber(candidate.x, 0, 0.96);
  const y = clampNumber(candidate.y, 0, 0.96);
  const width = clampNumber(candidate.width, 0.04, 1 - x);
  const height = clampNumber(candidate.height, 0.04, 1 - y);

  return { x, y, width, height };
}

function clampNumber(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function isQuotaError(message: string) {
  return /RESOURCE_EXHAUSTED|quota/i.test(message);
}

function dedupeQuestionRegions(regions: SegmentedQuestionRegion[]) {
  if (regions.length <= 1) {
    return regions;
  }

  const numberedCount = regions.filter((region) => region.questionNumber !== null).length;
  const filteredNulls =
    numberedCount >= 3 ? regions.filter((region) => region.questionNumber !== null) : [...regions];
  const uniqueByNumber = new Map<number, SegmentedQuestionRegion>();
  const nullRegions: SegmentedQuestionRegion[] = [];

  for (const region of filteredNulls) {
    if (region.questionNumber === null) {
      nullRegions.push(region);
      continue;
    }

    const existing = uniqueByNumber.get(region.questionNumber);

    if (!existing || compareQuestionRegions(region, existing) < 0) {
      uniqueByNumber.set(region.questionNumber, region);
    }
  }

  const collapsed = [...uniqueByNumber.values(), ...nullRegions].sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });

  return removeOverlappingQuestionRegions(collapsed);
}

function postProcessQuestionRegions(regions: SegmentedQuestionRegion[]) {
  if (regions.length === 0) {
    return regions;
  }

  const columns = inferQuestionColumnsFromRegions(regions);
  const expanded: SegmentedQuestionRegion[] = [];

  for (const column of columns) {
    const columnRegions = regions
      .filter((region) => resolveQuestionColumn(region, columns).id === column.id)
      .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x);

    columnRegions.forEach((region, index) => {
      const next = columnRegions[index + 1];
      const fullLeft = Math.max(0.02, column.left - 0.01);
      const fullRight = Math.min(0.98, column.right + 0.01);
      const paddedTop = Math.max(0.02, region.bounds.y - Math.max(0.018, region.bounds.height * 0.12));
      const naturalBottom = Math.min(
        0.97,
        region.bounds.y + region.bounds.height + Math.max(0.045, region.bounds.height * 0.22)
      );
      const maxBottom = next ? Math.max(paddedTop + 0.12, next.bounds.y - 0.018) : 0.97;
      const bottom = Math.min(maxBottom, Math.max(naturalBottom, region.bounds.y + region.bounds.height + 0.02));
      const bounds = normalizeRect({
        x: fullLeft,
        y: paddedTop,
        width: fullRight - fullLeft,
        height: bottom - paddedTop,
      });

      expanded.push({
        ...region,
        bounds: bounds ?? region.bounds,
      });
    });
  }

  return expanded.sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });
}

function dedupeAnswerAnchors(anchors: SegmentedAnswerAnchor[]) {
  if (anchors.length <= 1) {
    return anchors;
  }

  const uniqueByNumber = new Map<number, SegmentedAnswerAnchor>();
  const nullAnchors: SegmentedAnswerAnchor[] = [];

  for (const anchor of anchors) {
    if (anchor.questionNumber === null) {
      nullAnchors.push(anchor);
      continue;
    }

    const existing = uniqueByNumber.get(anchor.questionNumber);

    if (!existing || compareAnswerAnchors(anchor, existing) < 0) {
      uniqueByNumber.set(anchor.questionNumber, anchor);
    }
  }

  const collapsed = [...uniqueByNumber.values(), ...nullAnchors].sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });

  return removeOverlappingAnswerAnchors(collapsed);
}

function compareQuestionRegions(left: SegmentedQuestionRegion, right: SegmentedQuestionRegion) {
  const areaDiff = rectArea(right.bounds) - rectArea(left.bounds);

  if (Math.abs(areaDiff) > 0.0001) {
    return areaDiff;
  }

  return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
}

function compareAnswerAnchors(left: SegmentedAnswerAnchor, right: SegmentedAnswerAnchor) {
  const leftScore = rectArea(left.bounds) + (left.segments?.length ?? 0) * 0.002;
  const rightScore = rectArea(right.bounds) + (right.segments?.length ?? 0) * 0.002;

  if (Math.abs(rightScore - leftScore) > 0.0001) {
    return rightScore - leftScore;
  }

  return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
}

function removeOverlappingQuestionRegions(regions: SegmentedQuestionRegion[]) {
  const accepted: SegmentedQuestionRegion[] = [];

  for (const region of regions) {
    const overlapsExisting = accepted.some((current) => {
      if (
        region.questionNumber !== null &&
        current.questionNumber !== null &&
        region.questionNumber !== current.questionNumber
      ) {
        return false;
      }

      return rectContainment(region.bounds, current.bounds) > 0.82 || rectIoU(region.bounds, current.bounds) > 0.58;
    });

    if (!overlapsExisting) {
      accepted.push(region);
    }
  }

  return accepted;
}

function removeOverlappingAnswerAnchors(anchors: SegmentedAnswerAnchor[]) {
  const accepted: SegmentedAnswerAnchor[] = [];

  for (const anchor of anchors) {
    const overlapsExisting = accepted.some((current) => {
      if (
        anchor.questionNumber !== null &&
        current.questionNumber !== null &&
        anchor.questionNumber !== current.questionNumber
      ) {
        return false;
      }

      return rectContainment(anchor.bounds, current.bounds) > 0.82 || rectIoU(anchor.bounds, current.bounds) > 0.58;
    });

    if (!overlapsExisting) {
      accepted.push(anchor);
    }
  }

  return accepted;
}

function rectArea(rect: NormalizedRect) {
  return rect.width * rect.height;
}

function rectIntersectionArea(left: NormalizedRect, right: NormalizedRect) {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );

  return overlapWidth * overlapHeight;
}

function rectIoU(left: NormalizedRect, right: NormalizedRect) {
  const intersection = rectIntersectionArea(left, right);

  if (intersection <= 0) {
    return 0;
  }

  const union = rectArea(left) + rectArea(right) - intersection;
  return union > 0 ? intersection / union : 0;
}

function rectContainment(left: NormalizedRect, right: NormalizedRect) {
  const intersection = rectIntersectionArea(left, right);

  if (intersection <= 0) {
    return 0;
  }

  return Math.max(intersection / rectArea(left), intersection / rectArea(right));
}

function inferQuestionColumnsFromRegions(regions: SegmentedQuestionRegion[]) {
  const groups = regions
    .map((region) => ({
      region,
      center: region.bounds.x + region.bounds.width / 2,
    }))
    .sort((left, right) => left.center - right.center)
    .reduce<Array<Array<{ region: SegmentedQuestionRegion; center: number }>>>((current, item) => {
      const previous = current[current.length - 1];

      if (!previous) {
        current.push([item]);
        return current;
      }

      const previousCenter = previous.reduce((sum, entry) => sum + entry.center, 0) / previous.length;

      if (Math.abs(item.center - previousCenter) <= 0.18) {
        previous.push(item);
        return current;
      }

      current.push([item]);
      return current;
    }, []);

  const sortedGroups = groups
    .map((group, index) => ({
      id: `q-col-${index + 1}`,
      center: group.reduce((sum, entry) => sum + entry.center, 0) / group.length,
    }))
    .sort((left, right) => left.center - right.center);

  return sortedGroups.map((group, index) => {
    const previous = sortedGroups[index - 1];
    const next = sortedGroups[index + 1];
    const left = previous ? clampNumber((previous.center + group.center) / 2 - 0.02, 0.02, 0.92) : 0.04;
    const right = next ? clampNumber((group.center + next.center) / 2 + 0.02, 0.08, 0.98) : 0.96;

    return {
      id: group.id,
      left,
      right: Math.max(left + 0.22, right),
      center: group.center,
    };
  });
}

function resolveQuestionColumn(region: SegmentedQuestionRegion, columns: Array<{ id: string; left: number; right: number; center: number }>) {
  const center = region.bounds.x + region.bounds.width / 2;

  return [...columns].sort((left, right) => Math.abs(center - left.center) - Math.abs(center - right.center))[0];
}
