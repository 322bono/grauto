import assert from "node:assert/strict";
import test from "node:test";
import { POST as postGrade } from "@/app/api/grade/route";
import type { GradeRequestPayload } from "@/lib/types";

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

function buildMalformedGeminiJsonResponse(text: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text }],
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

function buildPayload(): GradeRequestPayload {
  return {
    uploadMode: "single",
    metadata: {
      subject: "수학",
      examName: "테스트",
      difficulty: "보통",
      durationMinutes: 40,
      takenAt: "2026-03-14",
    },
    questionSelections: [
      {
        id: "q1",
        pageNumber: 1,
        displayOrder: 1,
        bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        snapshotDataUrl: DATA_URL,
        analysisDataUrl: DATA_URL,
        extractedTextSnippet: "1. 보기 중 옳은 것을 고르시오. ① ② ③ ④ ⑤",
        questionNumberHint: 1,
      },
    ],
    answerPages: [
      {
        id: "a1",
        pageNumber: 7,
        pageImageDataUrl: DATA_URL,
        analysisImageDataUrl: DATA_URL,
        extractedTextSnippet: "다른 해설 페이지",
        answerAnchors: [],
      },
      {
        id: "a2",
        pageNumber: 8,
        pageImageDataUrl: DATA_URL,
        analysisImageDataUrl: DATA_URL,
        extractedTextSnippet: "1번 해설",
        answerAnchors: [
          {
            questionNumber: 1,
            bounds: { x: 0.1, y: 0.1, width: 0.6, height: 0.4 },
            textSnippet: "1번 해설",
          },
        ],
      },
    ],
  };
}

test("grade route normalizes multiple-choice answers and fixes answer page by anchors", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildGeminiJsonResponse({
      questions: [
        {
          selection_id: "q1",
          question_number: 1,
          detected_header_text: "1번 문제",
          question_type: "short-answer",
          student_answer: "④",
          correct_answer: "④",
          is_correct: true,
          score: 1,
          max_score: 1,
          confidence: 0.92,
          review_required: false,
          matched_answer_page_number: 7,
          matched_answer_reason: "model picked page 7",
          answer_region: { x: 0.12, y: 0.7, width: 0.2, height: 0.15 },
          explanation_region: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          work_evidence: {
            authenticity: "solved",
            rationale: "clear check mark",
            extracted_work: "",
            detected_marks: ["check"],
          },
          feedback: {
            mistake_reason: "",
            explanation: "정답입니다.",
            recommended_review: "",
            concept_tags: ["객관식"],
          },
        },
      ],
    });

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(buildPayload()),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      mode: string;
      questions: Array<{
        questionType: string;
        studentAnswer: string;
        correctAnswer: string;
        matchedAnswerPageNumber: number | null;
      }>;
    };

    assert.equal(body.mode, "vision");
    assert.equal(body.questions[0]?.questionType, "multiple-choice");
    assert.equal(body.questions[0]?.studentAnswer, "4");
    assert.equal(body.questions[0]?.correctAnswer, "4");
    assert.equal(body.questions[0]?.matchedAnswerPageNumber, 8);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route fails fast when Gemini request fails", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 500,
          message: "temporary response issue",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(buildPayload()),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /AI 채점에 실패했습니다/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route prefers the visible question number hint over selection order", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const payload = buildPayload();
  payload.questionSelections[0] = {
    ...payload.questionSelections[0],
    displayOrder: 2,
    questionNumberHint: 3,
    extractedTextSnippet: "3. 이차방정식 x^2-3x-1=0의 두 근 중 양수인 근은? ① ② ③ ④ ⑤",
  };
  payload.answerPages[1] = {
    ...payload.answerPages[1],
    pageNumber: 9,
    extractedTextSnippet: "3번 해설",
    answerAnchors: [
      {
        questionNumber: 3,
        bounds: { x: 0.1, y: 0.1, width: 0.6, height: 0.4 },
        textSnippet: "3번 해설",
      },
    ],
  };

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildGeminiJsonResponse({
      questions: [
        {
          selection_id: "q1",
          question_number: 2,
          detected_header_text: "2번 문제",
          question_type: "multiple-choice",
          student_answer: "⑤",
          correct_answer: "⑤",
          is_correct: true,
          score: 1,
          max_score: 1,
          confidence: 0.95,
          review_required: false,
          matched_answer_page_number: 7,
          matched_answer_reason: "model picked page 7",
          answer_region: { x: 0.12, y: 0.7, width: 0.2, height: 0.15 },
          explanation_region: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          work_evidence: {
            authenticity: "solved",
            rationale: "clear check mark",
            extracted_work: "",
            detected_marks: ["check"],
          },
          feedback: {
            mistake_reason: "",
            explanation: "정답입니다.",
            recommended_review: "",
            concept_tags: ["객관식"],
          },
        },
      ],
    });

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      questions: Array<{ questionNumber: number | null; matchedAnswerPageNumber: number | null }>;
    };

    assert.equal(body.questions[0]?.questionNumber, 3);
    assert.equal(body.questions[0]?.matchedAnswerPageNumber, 9);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route infers multiple-choice from dense option sequences even when model says short-answer", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const payload = buildPayload();
  payload.questionSelections[0] = {
    ...payload.questionSelections[0],
    extractedTextSnippet: "2. 1-2-3-4-5 중에서 맞는 값을 고르시오",
  };

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildGeminiJsonResponse({
      questions: [
        {
          selection_id: "q1",
          question_number: 2,
          detected_header_text: "2. 1-2-3-4-5",
          question_type: "short-answer",
          student_answer: "",
          correct_answer: "2",
          is_correct: false,
          score: 0,
          max_score: 1,
          confidence: 0.61,
          review_required: true,
          matched_answer_page_number: 8,
          matched_answer_reason: "matched page 8",
          answer_region: { x: 0.12, y: 0.7, width: 0.2, height: 0.15 },
          explanation_region: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          work_evidence: {
            authenticity: "unclear",
            rationale: "ocr noisy",
            extracted_work: "",
            detected_marks: [],
          },
          feedback: {
            mistake_reason: "",
            explanation: "",
            recommended_review: "",
            concept_tags: [],
          },
        },
      ],
    });

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      questions: Array<{ questionType: string; correctAnswer: string }>;
    };

    assert.equal(body.questions[0]?.questionType, "multiple-choice");
    assert.equal(body.questions[0]?.correctAnswer, "2");
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route does not return fallback payload on model failure", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const payload = buildPayload();
  payload.questionSelections[0] = {
    ...payload.questionSelections[0],
    extractedTextSnippet: "2. 다음 중 맞는 것을 고르시오 1) 4 2) 6 3) 8 4) 10 5) 12",
  };

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 500,
          message: "temporary response issue",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /fallback/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route returns 502 on broken JSON responses", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    buildMalformedGeminiJsonResponse('{"questions":[{"selection_id":"q1","question_number":1');

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(buildPayload()),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /AI 응답 형식이 깨져 채점을 완료하지 못했습니다/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grade route returns 429 on Gemini quota exhaustion", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message:
            "You exceeded your current quota. For more information on this error, head to: https://ai.google.dev/gemini-api/docs. Please retry in 26.388640656s.",
          details: [
            {
              retryDelay: "26s",
            },
          ],
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    const response = await postGrade(
      new Request("http://localhost/api/grade", {
        method: "POST",
        body: JSON.stringify(buildPayload()),
        headers: { "Content-Type": "application/json" },
      })
    );

    assert.equal(response.status, 429);
    const text = await response.text();
    assert.match(text, /약 26초 후 다시 시도/);
    assert.doesNotMatch(text, /https?:\/\//);
  } finally {
    global.fetch = originalFetch;
  }
});
