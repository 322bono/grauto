import { NextResponse } from "next/server";
import { imagePartFromDataUrl, type GeminiPart, generateGeminiJson } from "@/lib/gemini";
import type {
  AnalyzeRequestPayload,
  AnalyzeResponsePayload,
  QuestionDeepAnalysis,
  QuestionProcessStep,
} from "@/lib/types";

export const runtime = "nodejs";

const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["process_steps", "answer_sheet_basis", "one_line_summary"],
  properties: {
    process_steps: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "status", "summary", "detail"],
        properties: {
          order: { type: "number" },
          status: { type: "string", enum: ["correct", "incorrect"] },
          summary: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    answer_sheet_basis: { type: "string" },
    one_line_summary: { type: "string" },
  },
} as const;

const ANALYSIS_SYSTEM_PROMPT = `
You analyze one exam question.
Use the answer-sheet explanation as the primary source of truth.
Compare the student's remaining visible work against that explanation.
Ignore erased marks, overwritten traces, and anything not clearly visible.
Do not invent unseen symbols, answer choices, or math steps.

Return JSON only.

process_steps:
- 2 to 5 ordered steps.
- Each step must include order, status, summary, detail.
- status must be "correct" or "incorrect".
- Mark the first wrong reasoning step as incorrect.
- Steps before that can be correct if they match the valid method.

answer_sheet_basis:
- Summarize the relevant answer-sheet explanation for this question in 1 to 2 sentences.

one_line_summary:
- One sentence explaining what the student misunderstands and what to review next.
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as AnalyzeRequestPayload;

  if (!payload.selection || !payload.question) {
    return new NextResponse("분석할 문항 정보가 부족합니다.", { status: 400 });
  }

  if (shouldUseLocalAnswerSheetAnalysis(payload)) {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildLocalAnswerSheetAnalysis(payload),
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildFallbackAnalysis(payload.question.isCorrect),
    });
  }

  try {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: await requestGeminiAnalysis(payload, apiKey, model),
    });
  } catch {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildFallbackAnalysis(payload.question.isCorrect),
    });
  }
}

async function requestGeminiAnalysis(payload: AnalyzeRequestPayload, apiKey: string, model: string) {
  const parsed = await generateGeminiJson<{
    process_steps?: unknown[];
    answer_sheet_basis?: unknown;
    one_line_summary?: unknown;
  }>({
    apiKey,
    model,
    systemInstruction: ANALYSIS_SYSTEM_PROMPT,
    parts: buildGeminiUserParts(payload),
    responseJsonSchema: ANALYSIS_RESPONSE_SCHEMA,
    maxOutputTokens: 700,
    temperature: 0.1,
  });

  return normalizeAnalysis(parsed, payload);
}

function buildGeminiUserParts(payload: AnalyzeRequestPayload): GeminiPart[] {
  const { metadata, question, selection, answerPage, explanationCropDataUrl } = payload;

  const parts: GeminiPart[] = [
    {
      text: [
        `exam_name=${metadata.examName || "미입력"}`,
        `subject=${metadata.subject}`,
        `question_number=${question.questionNumber ?? "unknown"}`,
        `question_type=${question.questionType}`,
        `student_answer=${question.studentAnswer || "unknown"}`,
        `correct_answer=${question.correctAnswer || "unknown"}`,
        `is_correct=${question.isCorrect}`,
        `work_authenticity=${question.workEvidence.authenticity}`,
        `visible_work=${question.workEvidence.extractedWork || "없음"}`,
        `feedback_hint=${question.feedback.mistakeReason}`,
      ].join("\n"),
    },
    {
      text: "This is the student's question image. Only use the visible final work and marks.",
    },
    imagePartFromDataUrl(selection.analysisDataUrl ?? selection.snapshotDataUrl),
  ];

  if (answerPage) {
    parts.push({
      text: [
        `answer_page=${answerPage.pageNumber}`,
        `answer_page_text=${answerPage.extractedTextSnippet || "none"}`,
        "This is the answer sheet page.",
      ].join("\n"),
    });
    parts.push(imagePartFromDataUrl(answerPage.analysisImageDataUrl ?? answerPage.pageImageDataUrl));
  }

  if (explanationCropDataUrl) {
    parts.push({
      text: "This is the cropped explanation for the matched question. Prefer this crop over the full answer page.",
    });
    parts.push(imagePartFromDataUrl(explanationCropDataUrl));
  }

  return parts;
}

function shouldUseLocalAnswerSheetAnalysis(payload: AnalyzeRequestPayload) {
  const answerText = normalizeText(payload.answerPage?.extractedTextSnippet || "");
  const shortExplanation = normalizeText(payload.question.feedback.explanation || "");

  return answerText.length >= 28 || shortExplanation.length >= 36;
}

function buildLocalAnswerSheetAnalysis(payload: AnalyzeRequestPayload): QuestionDeepAnalysis {
  const { question, answerPage } = payload;
  const answerSheetText = takeFirstSentences(answerPage?.extractedTextSnippet || question.feedback.explanation || "", 2);
  const processSteps = buildLocalProcessSteps(payload);

  return {
    requestedAt: new Date().toISOString(),
    processSteps,
    reasonSteps: processSteps.map((step) => step.summary),
    answerSheetBasis:
      answerSheetText ||
      "답지 텍스트가 충분하지 않아 보이는 해설 범위와 기본 채점 메모를 기준으로 요약했습니다.",
    oneLineSummary: buildOneLineSummary(payload, answerSheetText),
  };
}

function normalizeAnalysis(
  raw: {
    process_steps?: unknown[];
    answer_sheet_basis?: unknown;
    one_line_summary?: unknown;
  },
  payload: AnalyzeRequestPayload
): QuestionDeepAnalysis {
  const processSteps = normalizeProcessSteps(raw.process_steps, payload.question.isCorrect, payload);

  return {
    requestedAt: new Date().toISOString(),
    processSteps,
    reasonSteps: processSteps.map((step) => step.summary),
    answerSheetBasis: takeString(
      raw.answer_sheet_basis,
      "답지 해설에서 확인되는 핵심 풀이를 바탕으로 요약했습니다."
    ),
    oneLineSummary: takeString(
      raw.one_line_summary,
      buildOneLineSummary(payload, payload.question.feedback.explanation || "")
    ),
  };
}

function buildLocalProcessSteps(payload: AnalyzeRequestPayload): QuestionProcessStep[] {
  const { question } = payload;

  return [
    {
      order: 1,
      status: "correct",
      summary: question.studentAnswer
        ? `학생의 최종 답은 ${question.studentAnswer}로 인식되었습니다.`
        : "학생의 최종 답은 명확하게 인식되지 않았습니다.",
      detail: question.workEvidence.extractedWork
        ? `보이는 풀이 흔적은 ${trimForSentence(question.workEvidence.extractedWork, 96)} 정도입니다.`
        : "남아 있는 풀이 흔적이 많지 않아 최종 답 중심으로 확인했습니다.",
    },
    {
      order: 2,
      status: question.isCorrect ? "correct" : "incorrect",
      summary: question.isCorrect
        ? `학생 답이 정답 ${question.correctAnswer || ""}와 일치합니다.`
        : `학생 답이 정답 ${question.correctAnswer || ""}와 일치하지 않습니다.`,
      detail: question.feedback.mistakeReason || question.feedback.explanation,
    },
    {
      order: 3,
      status: question.isCorrect ? "correct" : "incorrect",
      summary: question.isCorrect
        ? "답지 해설의 핵심 계산 순서와 학생 풀이 방향이 크게 어긋나지 않습니다."
        : "답지 해설이 요구하는 조건 확인 또는 계산 순서와 학생 풀이가 어긋납니다.",
      detail:
        question.feedback.recommendedReview ||
        question.feedback.explanation ||
        "답지의 핵심 조건과 계산 순서를 다시 확인해 주세요.",
    },
  ];
}

function normalizeProcessSteps(
  value: unknown,
  isCorrect: boolean,
  payload: AnalyzeRequestPayload
): QuestionProcessStep[] {
  if (Array.isArray(value)) {
    const steps = value
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const candidate = item as {
          order?: unknown;
          status?: unknown;
          summary?: unknown;
          detail?: unknown;
        };
        const summary = takeString(candidate.summary, "");

        if (!summary) {
          return null;
        }

        return {
          order: typeof candidate.order === "number" && Number.isFinite(candidate.order) ? candidate.order : index + 1,
          status: candidate.status === "correct" ? "correct" : "incorrect",
          summary,
          detail: takeString(candidate.detail, summary),
        } satisfies QuestionProcessStep;
      })
      .filter((step): step is NonNullable<typeof step> => Boolean(step))
      .slice(0, 5);

    if (steps.length >= 2) {
      return steps;
    }
  }

  return buildLocalProcessSteps(payload).map((step, index) => ({
    ...step,
    order: index + 1,
    status: index === 1 && !isCorrect ? "incorrect" : step.status,
  }));
}

function buildFallbackAnalysis(isCorrect: boolean): QuestionDeepAnalysis {
  const processSteps: QuestionProcessStep[] = [
    {
      order: 1,
      status: "correct",
      summary: "학생의 최종 답과 보이는 풀이 흔적을 먼저 확인했습니다.",
      detail: "현재는 해설 OCR과 모델 응답이 충분하지 않아 보이는 정보만 기준으로 정리했습니다.",
    },
    {
      order: 2,
      status: isCorrect ? "correct" : "incorrect",
      summary: isCorrect
        ? "최종 답은 정답과 맞는 방향으로 보입니다."
        : "최종 답이 답지 해설과 맞지 않는 방향으로 보입니다.",
      detail: isCorrect
        ? "답지 해설의 핵심 조건을 다시 짚어 같은 방식으로 풀어보면 좋습니다."
        : "답지 해설의 조건 확인, 공식 적용, 계산 순서를 다시 비교해 보세요.",
    },
  ];

  return {
    requestedAt: new Date().toISOString(),
    processSteps,
    reasonSteps: processSteps.map((step) => step.summary),
    answerSheetBasis: "답지 텍스트가 충분하지 않아 보수적으로 요약했습니다.",
    oneLineSummary: isCorrect
      ? "정답 흐름은 맞으니 답지 해설의 핵심 근거를 다시 짚어 같은 방식으로 복습해 보세요."
      : "답지 해설이 강조하는 조건과 계산 순서를 다시 확인하고 같은 유형으로 복습해 보세요.",
  };
}

function takeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function takeFirstSentences(value: string, count: number) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "";
  }

  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (parts.length > 0 ? parts.slice(0, count) : [normalized]).join(" ");
}

function trimForSentence(value: string, maxLength: number) {
  const normalized = normalizeText(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function buildOneLineSummary(payload: AnalyzeRequestPayload, answerSheetText: string) {
  const tags = payload.question.feedback.conceptTags.filter(Boolean).slice(0, 2);
  const review = normalizeText(payload.question.feedback.recommendedReview || "");

  if (tags.length > 0 && review) {
    return `${tags.join(", ")} 개념을 다시 정리하고 ${trimForSentence(review, 56)} 방향으로 복습해 보세요.`;
  }

  if (tags.length > 0) {
    return `${tags.join(", ")} 개념과 답지 해설의 핵심 계산 순서를 다시 연결해서 복습해 보세요.`;
  }

  if (answerSheetText) {
    return "답지 해설의 계산 순서와 학생 풀이의 어긋나는 지점을 다시 직접 비교해 보세요.";
  }

  return "남아 있는 풀이 흔적을 단계별로 다시 쓰고, 답지 해설의 계산 순서를 한 번 더 따라가 보세요.";
}
