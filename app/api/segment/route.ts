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

  return regions.sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });
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

  return anchors.sort((left, right) => {
    if (left.questionNumber !== null && right.questionNumber !== null && left.questionNumber !== right.questionNumber) {
      return left.questionNumber - right.questionNumber;
    }

    return left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x;
  });
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
