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

const QUESTION_SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question_regions"],
  properties: {
    question_regions: {
      type: "array",
      items: {
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
      },
    },
  },
} as const;

const ANSWER_SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer_anchors"],
  properties: {
    answer_anchors: {
      type: "array",
      items: {
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
      },
    },
  },
} as const;

const QUESTION_SEGMENT_PROMPT = `
You receive one scanned exam question page.
Return JSON only.

Task:
- Detect every real question block on the page.
- Each block must contain exactly one question stem and its related choices or answer area.
- Ignore page headers, section headers, page numbers, score labels, and isolated answer choices.
- Do not merge two different questions into one block.
- If the page has multiple columns, still separate each question correctly.

Rules:
- question_number should be the visible problem number when readable, otherwise null.
- bounds must be normalized 0..1.
- bounds must be tight and must not include neighboring questions.
- Sort questions by their real question number when visible. Otherwise use reading order.
`;

const ANSWER_SEGMENT_PROMPT = `
You receive one scanned answer or explanation page.
Return JSON only.

Task:
- Detect each question's explanation block on the page.
- Each returned item must belong to one question number only.
- Do not return the whole page for one question.
- If one question's explanation continues in another column or another vertical segment on the same page, include all pieces in segments.

Rules:
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
    const pages: SegmentResponsePayload["pages"] = [];

    for (const page of payload.pages) {
      if (payload.mode === "questions") {
        const questionRegions = await segmentQuestionPage(apiKey, model, page.pageNumber, page.pageImageDataUrl, page.textSnippet);
        pages.push({
          pageNumber: page.pageNumber,
          questionRegions,
        });
      } else {
        const answerAnchors = await segmentAnswerPage(apiKey, model, page.pageNumber, page.pageImageDataUrl, page.textSnippet);
        pages.push({
          pageNumber: page.pageNumber,
          answerAnchors,
        });
      }
    }

    return NextResponse.json({
      mode: payload.mode,
      pages,
    } satisfies SegmentResponsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Segmentation failed.";
    return new NextResponse(message, { status: 500 });
  }
}

async function segmentQuestionPage(
  apiKey: string,
  model: string,
  pageNumber: number,
  pageImageDataUrl: string,
  textSnippet?: string
) {
  const parsed = await generateGeminiJson<{
    question_regions?: Array<{
      question_number?: number | null;
      bounds?: NormalizedRect;
      text_snippet?: string;
    }>;
  }>({
    apiKey,
    model,
    systemInstruction: QUESTION_SEGMENT_PROMPT,
    parts: buildPageParts("questions", pageNumber, pageImageDataUrl, textSnippet),
    responseJsonSchema: QUESTION_SEGMENT_SCHEMA,
    maxOutputTokens: 1400,
    temperature: 0,
  });

  return normalizeQuestionRegions(parsed.question_regions);
}

async function segmentAnswerPage(
  apiKey: string,
  model: string,
  pageNumber: number,
  pageImageDataUrl: string,
  textSnippet?: string
) {
  const parsed = await generateGeminiJson<{
    answer_anchors?: Array<{
      question_number?: number | null;
      bounds?: NormalizedRect;
      text_snippet?: string;
      segments?: NormalizedRect[];
    }>;
  }>({
    apiKey,
    model,
    systemInstruction: ANSWER_SEGMENT_PROMPT,
    parts: buildPageParts("answers", pageNumber, pageImageDataUrl, textSnippet),
    responseJsonSchema: ANSWER_SEGMENT_SCHEMA,
    maxOutputTokens: 1800,
    temperature: 0,
  });

  return normalizeAnswerAnchors(parsed.answer_anchors);
}

function buildPageParts(
  mode: "questions" | "answers",
  pageNumber: number,
  pageImageDataUrl: string,
  textSnippet?: string
): GeminiPart[] {
  return [
    {
      text: [
        `mode=${mode}`,
        `page_number=${pageNumber}`,
        `page_text_hint=${textSnippet || "none"}`,
      ].join("\n"),
    },
    imagePartFromDataUrl(pageImageDataUrl),
  ];
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
