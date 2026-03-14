import assert from "node:assert/strict";
import test from "node:test";
import { POST as postSegment } from "@/app/api/segment/route";
import type { SegmentRequestPayload } from "@/lib/types";

const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WHQr3sAAAAASUVORK5CYII=";

function buildGeminiJsonResponse(body: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(body) }],
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

test("segment route batches multiple pages into one Gemini request", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  let fetchCalls = 0;
  const originalFetch = global.fetch;

  global.fetch = async () => {
    fetchCalls += 1;
    return buildGeminiJsonResponse({
      pages: [
        {
          page_number: 1,
          question_regions: [
            {
              question_number: 1,
              bounds: { x: 0.1, y: 0.1, width: 0.35, height: 0.2 },
              text_snippet: "1번 문제",
            },
          ],
        },
        {
          page_number: 2,
          question_regions: [
            {
              question_number: 2,
              bounds: { x: 0.12, y: 0.16, width: 0.33, height: 0.21 },
              text_snippet: "2번 문제",
            },
          ],
        },
      ],
    });
  };

  try {
    const payload: SegmentRequestPayload = {
      mode: "questions",
      pages: [
        { pageNumber: 1, pageImageDataUrl: DATA_URL, textSnippet: "page one" },
        { pageNumber: 2, pageImageDataUrl: DATA_URL, textSnippet: "page two" },
      ],
    };

    const response = await postSegment(
      new Request("http://localhost/api/segment", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 1);

    const body = (await response.json()) as {
      pages: Array<{ pageNumber: number; questionRegions?: Array<{ questionNumber: number | null }> }>;
    };

    assert.equal(body.pages.length, 2);
    assert.equal(body.pages[0]?.pageNumber, 1);
    assert.equal(body.pages[0]?.questionRegions?.[0]?.questionNumber, 1);
    assert.equal(body.pages[1]?.pageNumber, 2);
    assert.equal(body.pages[1]?.questionRegions?.[0]?.questionNumber, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("segment route returns a friendly 429 message on Gemini free-tier quota exhaustion", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "RESOURCE_EXHAUSTED: quota exceeded",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    const payload: SegmentRequestPayload = {
      mode: "answers",
      pages: [{ pageNumber: 3, pageImageDataUrl: DATA_URL, textSnippet: "answer page" }],
    };

    const response = await postSegment(
      new Request("http://localhost/api/segment", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 429);
    const text = await response.text();
    assert.match(text, /무료 등급 분당 요청 제한/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("segment route removes duplicate and null question regions from the same page", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildGeminiJsonResponse({
      pages: [
        {
          page_number: 4,
          question_regions: [
            {
              question_number: 1,
              bounds: { x: 0.08, y: 0.12, width: 0.4, height: 0.16 },
              text_snippet: "1번 문제",
            },
            {
              question_number: 1,
              bounds: { x: 0.09, y: 0.13, width: 0.38, height: 0.14 },
              text_snippet: "1번 중복",
            },
            {
              question_number: null,
              bounds: { x: 0.12, y: 0.17, width: 0.33, height: 0.1 },
              text_snippet: "가짜 추가 문항",
            },
            {
              question_number: 2,
              bounds: { x: 0.08, y: 0.34, width: 0.42, height: 0.18 },
              text_snippet: "2번 문제",
            },
            {
              question_number: 3,
              bounds: { x: 0.55, y: 0.12, width: 0.35, height: 0.16 },
              text_snippet: "3번 문제",
            },
          ],
        },
      ],
    });

  try {
    const payload: SegmentRequestPayload = {
      mode: "questions",
      pages: [{ pageNumber: 4, pageImageDataUrl: DATA_URL, textSnippet: "1 2 3" }],
    };

    const response = await postSegment(
      new Request("http://localhost/api/segment", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      pages: Array<{ questionRegions?: Array<{ questionNumber: number | null }> }>;
    };

    assert.deepEqual(
      body.pages[0]?.questionRegions?.map((region) => region.questionNumber),
      [1, 2, 3]
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("segment route expands narrow question boxes to the full column width", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildGeminiJsonResponse({
      pages: [
        {
          page_number: 6,
          question_regions: [
            {
              question_number: 1,
              bounds: { x: 0.28, y: 0.14, width: 0.22, height: 0.12 },
              text_snippet: "1번 문제",
            },
            {
              question_number: 2,
              bounds: { x: 0.29, y: 0.34, width: 0.21, height: 0.12 },
              text_snippet: "2번 문제",
            },
          ],
        },
      ],
    });

  try {
    const payload: SegmentRequestPayload = {
      mode: "questions",
      pages: [{ pageNumber: 6, pageImageDataUrl: DATA_URL, textSnippet: "1 2" }],
    };

    const response = await postSegment(
      new Request("http://localhost/api/segment", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      pages: Array<{
        questionRegions?: Array<{ questionNumber: number | null; bounds: { x: number; width: number } }>;
      }>;
    };

    const firstRegion = body.pages[0]?.questionRegions?.[0];
    assert.ok(firstRegion);
    assert.equal(firstRegion?.questionNumber, 1);
    assert.ok((firstRegion?.bounds.x ?? 1) < 0.2);
    assert.ok((firstRegion?.bounds.width ?? 0) > 0.4);
  } finally {
    global.fetch = originalFetch;
  }
});
