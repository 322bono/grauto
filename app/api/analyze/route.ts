import { NextResponse } from "next/server";
import { imagePartFromDataUrl, type GeminiPart, generateGeminiJson } from "@/lib/gemini";
import type { AnalyzeRequestPayload, AnalyzeResponsePayload, QuestionDeepAnalysis } from "@/lib/types";

export const runtime = "nodejs";

const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason_steps", "answer_sheet_basis", "one_line_summary"],
  properties: {
    reason_steps: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" }
    },
    answer_sheet_basis: { type: "string" },
    one_line_summary: { type: "string" }
  }
} as const;

const ANALYSIS_SYSTEM_PROMPT = `
당신은 오답 원인을 "답지 해설 근거"로 설명하는 학습 코치입니다.
이번 호출은 한 문항만 분석합니다.

분석 순서:
1. 답지 해설 이미지와 답지 OCR 텍스트를 먼저 읽습니다.
2. 학생이 남긴 최종 풀이와 최종 답만 읽습니다.
3. 두 자료를 비교해 어디서 논리가 어긋났는지 단계별로 설명합니다.
4. 답지에 실제로 적혀 있는 핵심 내용을 바탕으로 학생이 이해하지 못한 부분을 보완해 설명합니다.

중요 규칙:
- 답지 해설에 보이는 내용이 있으면 그 근거를 최우선으로 사용합니다.
- 지운 흔적, 수정 흔적, 덧칠은 무시하고 현재 남아 있는 최종 풀이만 봅니다.
- 보이지 않는 보기, 기호, 문장, 선택지를 추측하지 않습니다.
- 답지에서 확인되지 않는 내용은 지어내지 않습니다.
- 근거가 부족하면 보수적으로 표현합니다.

출력 규칙:
- 반드시 JSON만 반환합니다.
- reason_steps: 2~5개의 짧고 구체적인 단계
- answer_sheet_basis: 답지 해설의 핵심 내용을 1~2문장으로 정리
- one_line_summary: 현재 무엇을 잘못 이해했고 다음에 무엇을 복습해야 하는지 1문장으로 요약
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as AnalyzeRequestPayload;

  if (!payload.selection || !payload.question) {
    return new NextResponse("분석할 문항 정보가 부족합니다.", { status: 400 });
  }

  if (shouldUseLocalAnswerSheetAnalysis(payload)) {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildLocalAnswerSheetAnalysis(payload)
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildFallbackAnalysis(payload.question.isCorrect)
    });
  }

  try {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: await requestGeminiAnalysis(payload, apiKey, model)
    });
  } catch {
    return NextResponse.json<AnalyzeResponsePayload>({
      analysis: buildFallbackAnalysis(payload.question.isCorrect)
    });
  }
}

async function requestGeminiAnalysis(payload: AnalyzeRequestPayload, apiKey: string, model: string) {
  const parsed = await generateGeminiJson<{
    reason_steps?: unknown[];
    answer_sheet_basis?: unknown;
    one_line_summary?: unknown;
  }>({
    apiKey,
    model,
    systemInstruction: ANALYSIS_SYSTEM_PROMPT,
    parts: buildGeminiUserParts(payload),
    responseJsonSchema: ANALYSIS_RESPONSE_SCHEMA,
    maxOutputTokens: 520,
    temperature: 0.15
  });

  return normalizeAnalysis(parsed, payload.question.isCorrect);
}

function buildGeminiUserParts(payload: AnalyzeRequestPayload): GeminiPart[] {
  const { metadata, question, selection, answerPage, explanationCropDataUrl } = payload;

  const parts: GeminiPart[] = [
    {
      text: [
        `시험명: ${metadata.examName || "미입력"}`,
        `과목: ${metadata.subject}`,
        `문항 번호: ${question.questionNumber ?? "미상"}`,
        `문항 유형: ${question.questionType}`,
        `학생 답안: ${question.studentAnswer || "미인식"}`,
        `모범 답안: ${question.correctAnswer || "미인식"}`,
        `정오 판정: ${question.isCorrect ? "True" : "False"}`,
        `풀이 흔적 판정: ${question.workEvidence.authenticity}`,
        `학생 풀이 흔적: ${question.workEvidence.extractedWork || "미인식"}`,
        `기본 채점 메모: ${question.feedback.mistakeReason}`,
        `기본 채점 설명: ${question.feedback.explanation}`
      ].join("\n")
    },
    {
      text: "아래 이미지는 학생이 실제로 풀이한 문제 영역입니다. 현재 남아 있는 최종 풀이와 최종 답만 기준으로 분석해 주세요."
    },
    imagePartFromDataUrl(selection.snapshotDataUrl)
  ];

  if (answerPage) {
    parts.push({
      text: [
        `답안 페이지 번호: ${answerPage.pageNumber}`,
        `답안 OCR 텍스트: ${answerPage.extractedTextSnippet || "OCR 텍스트가 충분하지 않음"}`,
        "아래 이미지는 정답과 해설이 들어 있는 답안 페이지입니다. 보이지 않는 내용은 추측하지 마세요."
      ].join("\n")
    });
    parts.push(imagePartFromDataUrl(answerPage.pageImageDataUrl));
  }

  if (explanationCropDataUrl) {
    parts.push({
      text: "아래 이미지는 해당 문항 해설만 잘라낸 이미지입니다. 가능하면 이 이미지와 OCR 텍스트를 최우선 근거로 설명해 주세요."
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
  const reasonSteps: string[] = [];

  if (!question.isCorrect) {
    if (question.studentAnswer && question.correctAnswer) {
      reasonSteps.push(`학생 답안은 ${question.studentAnswer}로 인식됐지만 정답은 ${question.correctAnswer}입니다.`);
    } else {
      reasonSteps.push("학생 답안이 정답과 일치하지 않는 것으로 보이지만 답안 인식 정보가 충분하지 않습니다.");
    }
  } else {
    reasonSteps.push("정답 문항이므로 오답 원인보다 해설 요약 중심으로 정리했습니다.");
  }

  if (question.workEvidence.extractedWork) {
    reasonSteps.push(`학생 풀이 흔적에는 ${trimForSentence(question.workEvidence.extractedWork, 80)} 내용이 남아 있습니다.`);
  } else {
    reasonSteps.push("학생 풀이 흔적이 희미해 중간 단계의 근거는 제한적으로만 확인됩니다.");
  }

  if (answerSheetText) {
    reasonSteps.push(`답지 해설에서는 ${trimForSentence(answerSheetText, 120)} 쪽의 설명이 핵심 근거로 보입니다.`);
  } else {
    reasonSteps.push("답지 OCR 텍스트가 짧아 화면에 보이는 해설 범위 안에서만 보수적으로 정리했습니다.");
  }

  if (!question.isCorrect) {
    if (question.feedback.recommendedReview) {
      reasonSteps.push(`${trimForSentence(question.feedback.recommendedReview, 80)} 방향으로 다시 복습하면 좋습니다.`);
    } else {
      reasonSteps.push("답지 해설이 요구하는 조건 확인 또는 개념 연결 단계가 학생 풀이에서 충분히 드러나지 않습니다.");
    }
  }

  return {
    requestedAt: new Date().toISOString(),
    reasonSteps: reasonSteps.slice(0, 5),
    answerSheetBasis:
      answerSheetText ||
      "답지 텍스트가 충분하지 않아 학생 풀이와 기본 채점 메모를 중심으로 해설 근거를 정리했습니다.",
    oneLineSummary: buildOneLineSummary(payload, answerSheetText)
  };
}

function normalizeAnalysis(
  raw: {
    reason_steps?: unknown[];
    answer_sheet_basis?: unknown;
    one_line_summary?: unknown;
  },
  isCorrect: boolean
): QuestionDeepAnalysis {
  return {
    requestedAt: new Date().toISOString(),
    reasonSteps: normalizeSteps(raw?.reason_steps, isCorrect),
    answerSheetBasis: takeString(
      raw?.answer_sheet_basis,
      "답지 해설의 핵심 문장을 충분히 읽지 못해, 확인된 범위 안에서만 요약했습니다."
    ),
    oneLineSummary: takeString(
      raw?.one_line_summary,
      isCorrect
        ? "정답 흐름은 맞았으니 답지 해설의 핵심 근거를 한 번 더 확인해 같은 방식으로 반복해 보세요."
        : "답지 해설이 강조하는 핵심 조건과 풀이 순서를 다시 확인하고, 같은 유형 문제로 복습해 보세요."
    )
  };
}

function normalizeSteps(value: unknown, isCorrect: boolean) {
  if (Array.isArray(value)) {
    const steps = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5);

    if (steps.length >= 2) {
      return steps;
    }
  }

  return [
    isCorrect
      ? "정답 문항이어서 오답 원인 대신 해설의 핵심 흐름을 중심으로 정리했습니다."
      : "학생 풀이에서 정답으로 연결되는 핵심 단계가 충분히 드러나지 않습니다.",
    isCorrect
      ? "답지 해설과 같은 흐름이 보이지만 근거를 더 또렷하게 적는 연습이 필요합니다."
      : "답지 해설이 요구하는 조건 확인 또는 개념 연결 단계가 학생 풀이에서 약하게 보입니다."
  ];
}

function buildFallbackAnalysis(isCorrect: boolean): QuestionDeepAnalysis {
  return {
    requestedAt: new Date().toISOString(),
    reasonSteps: [
      isCorrect
        ? "정답 문항이라 강한 오답 분석 대신 해설 요약 중심으로만 정리했습니다."
        : "학생 풀이와 답지 해설의 핵심 흐름이 완전히 겹치지 않습니다.",
      isCorrect
        ? "답지 해설의 근거를 한 번 더 짚어 두면 다음에도 안정적으로 풀 수 있습니다."
        : "답지 해설이 요구하는 조건 확인 또는 개념 연결이 학생 풀이에서 충분히 드러나지 않습니다."
    ],
    answerSheetBasis: "답지 텍스트 또는 모델 응답이 모두 충분하지 않아 보수적으로 정리했습니다.",
    oneLineSummary: isCorrect
      ? "정답 흐름은 유지하고 있으니 답지 해설의 핵심 근거를 짧게 정리하는 연습만 더 해 보세요."
      : "답지 해설이 강조하는 개념과 조건 확인 순서를 다시 복습하고, 중간 풀이를 더 또렷하게 남겨 보세요."
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
    .split(/(?<=[.!?。！？])\s+/)
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
    return `${tags.join(", ")} 개념을 다시 정리하고 ${trimForSentence(review, 56)} 방향으로 복습하면 오답 원인이 더 분명해집니다.`;
  }

  if (tags.length > 0) {
    return `${tags.join(", ")} 개념을 다시 점검하고 답지 해설의 핵심 단계와 학생 풀이를 직접 비교해 보세요.`;
  }

  if (answerSheetText) {
    return "답지 해설의 핵심 조건과 학생 풀이의 중간 단계를 직접 대조하면 어디서 어긋났는지 더 정확히 보입니다.";
  }

  return "학생 풀이의 중간 근거를 더 또렷하게 남기고, 같은 유형의 핵심 개념을 다시 정리해 보세요.";
}
