import { NextResponse } from "next/server";
import { imagePartFromDataUrl, type GeminiPart, generateGeminiJson } from "@/lib/gemini";
import { findBestAnswerPageByAnchors, rankAnswerPageCandidates } from "@/lib/page-matching";
import { buildSummary } from "@/lib/summary";
import { normalizeReadableText } from "@/lib/text-quality";
import type {
  AnswerPagePayload,
  BoundingBox,
  GradeRequestPayload,
  GradeResponsePayload,
  QuestionResult,
  QuestionType,
  WorkAuthenticity,
} from "@/lib/types";

export const runtime = "nodejs";

const MAX_CANDIDATE_PAGES = 3;

const GRADE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "selection_id",
          "question_number",
          "detected_header_text",
          "question_type",
          "student_answer",
          "correct_answer",
          "is_correct",
          "score",
          "max_score",
          "confidence",
          "review_required",
          "matched_answer_page_number",
          "matched_answer_reason",
          "answer_region",
          "explanation_region",
          "work_evidence",
          "feedback",
        ],
        properties: {
          selection_id: { type: "string" },
          question_number: { type: "number" },
          detected_header_text: { type: "string" },
          question_type: { type: "string", enum: ["multiple-choice", "short-answer", "essay"] },
          student_answer: { type: "string" },
          correct_answer: { type: "string" },
          is_correct: { type: "boolean" },
          score: { type: "number" },
          max_score: { type: "number" },
          confidence: { type: "number" },
          review_required: { type: "boolean" },
          matched_answer_page_number: { type: "number" },
          matched_answer_reason: { type: "string" },
          answer_region: {
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
          explanation_region: {
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
          work_evidence: {
            type: "object",
            additionalProperties: false,
            required: ["authenticity", "rationale", "extracted_work", "detected_marks"],
            properties: {
              authenticity: { type: "string", enum: ["solved", "guessed", "blank", "unclear"] },
              rationale: { type: "string" },
              extracted_work: { type: "string" },
              detected_marks: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          feedback: {
            type: "object",
            additionalProperties: false,
            required: ["mistake_reason", "explanation", "recommended_review", "concept_tags"],
            properties: {
              mistake_reason: { type: "string" },
              explanation: { type: "string" },
              recommended_review: { type: "string" },
              concept_tags: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `
You grade scanned exam pages.
Return JSON only.

Goals:
1. Match each question image to the best answer page candidate.
2. For multiple-choice questions, detect the selected option number from the visible mark.
3. Judge correctness only by comparing the student's final answer to the correct answer.
4. Ignore erased traces or uncertain overwritten marks.
5. Keep answer_region and explanation_region tight.

Rules:
- If a visible check, V mark, slash, circle, or emphasis is attached to one choice, student_answer must be the option number only.
- Example: a mark near ④ means student_answer="4".
- If the choice mark is visually clear, do not return blank.
- matched_answer_page_number must prefer a candidate page whose anchor numbers include the current question number.
- mistake_reason: 1 sentence max.
- explanation: 2 sentences max.
- recommended_review: 1 sentence max.
- concept_tags: max 3 items.
- Set review_required=true when confidence is low or the answer page match is uncertain.
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as GradeRequestPayload;

  if (!payload.questionSelections?.length || !payload.answerPages?.length) {
    return new NextResponse("문제 문항과 답안 페이지를 먼저 선택해 주세요.", { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return new NextResponse("GEMINI_API_KEY가 설정되지 않았습니다. 서버 환경 변수를 확인해 주세요.", {
      status: 500,
    });
  }

  try {
    const parsed = await generateGeminiJson<{ questions?: unknown[] }>({
      apiKey,
      model,
      systemInstruction: SYSTEM_PROMPT,
      parts: buildUserParts(payload),
      responseJsonSchema: GRADE_RESPONSE_SCHEMA,
      maxOutputTokens: estimateOutputTokens(payload.questionSelections.length),
      temperature: 0,
    });

    return NextResponse.json(normalizeResponse(payload, parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automatic grading failed.";
    return buildGradeErrorResponse(message);
  }
}

function buildGradeErrorResponse(rawMessage: string) {
  const normalizedReason = extractFailureReason(rawMessage);

  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|free_tier|too many requests|429/i.test(normalizedReason)) {
    const retryDelaySeconds = extractRetryDelaySeconds(rawMessage, normalizedReason);

    return new NextResponse(
      retryDelaySeconds !== null
        ? `Gemini quota가 초과되었습니다. 약 ${retryDelaySeconds}초 후 다시 시도해 주세요.`
        : "Gemini quota가 초과되었습니다. 잠시 후 다시 시도해 주세요.",
      { status: 429 }
    );
  }

  if (/JSON parse failed|Unexpected end of JSON|double-quoted property name|Expected .* in JSON/i.test(normalizedReason)) {
    return new NextResponse(
      "AI 응답 형식이 깨져 채점을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      { status: 502 }
    );
  }

  return new NextResponse(
    `AI 채점에 실패했습니다. 상세 원인: ${summarizeFailureReason(normalizedReason) || "unknown error"}`,
    { status: 502 }
  );
}

function buildUserParts(payload: GradeRequestPayload): GeminiPart[] {
  const parts: GeminiPart[] = [
    {
      text: [
        `exam_name=${payload.metadata.examName || "untitled"}`,
        `subject=${payload.metadata.subject || "unknown"}`,
        `difficulty=${payload.metadata.difficulty || "unknown"}`,
        `duration_minutes=${payload.metadata.durationMinutes ?? "unknown"}`,
        `taken_at=${payload.metadata.takenAt || "unknown"}`,
        "",
        "Use the best answer page candidate for each selected question.",
      ].join("\n"),
    },
  ];

  payload.questionSelections.forEach((selection, index) => {
    const rankedCandidates = rankAnswerPageCandidates(selection, payload.answerPages);
    const candidatePages = rankedCandidates.slice(0, MAX_CANDIDATE_PAGES).map((item) => item.page);
    const candidateHints = rankedCandidates
      .slice(0, MAX_CANDIDATE_PAGES)
      .map((item) => {
        const anchorNumbers = getAnchorQuestionNumbers(item.page).join(",");
        return `- page=${item.page.pageNumber}, anchors=${anchorNumbers || "none"}, score=${item.score.toFixed(2)}, reasons=${item.reasons.join(" / ")}`;
      })
      .join("\n");

    parts.push({
      text: [
        `question_index=${index + 1}`,
        `selection_id=${selection.id}`,
        `question_page=${selection.pageNumber}`,
        `question_number_hint=${selection.questionNumberHint ?? selection.displayOrder ?? "unknown"}`,
        `text_hint=${selection.extractedTextSnippet || "none"}`,
        "multiple_choice_hint=If there is a visible mark on one option, return only that option number as student_answer.",
        "answer_page_candidates:",
        candidateHints || "- none",
      ].join("\n"),
    });

    parts.push(imagePartFromDataUrl(selection.analysisDataUrl ?? selection.snapshotDataUrl));

    candidatePages.forEach((page, candidateIndex) => {
      const anchorNumbers = getAnchorQuestionNumbers(page).join(",");

      parts.push({
        text: `answer_candidate page=${page.pageNumber}, anchors=${anchorNumbers || "none"}, text_hint=${page.extractedTextSnippet || "none"}, primary_candidate=${candidateIndex === 0}`,
      });
      parts.push(imagePartFromDataUrl(page.analysisImageDataUrl ?? page.pageImageDataUrl));
    });
  });

  return parts;
}

function estimateOutputTokens(questionCount: number) {
  return Math.min(2200, Math.max(700, 260 + questionCount * 220));
}

function normalizeResponse(payload: GradeRequestPayload, parsed: { questions?: unknown[] }): GradeResponsePayload {
  const questions = payload.questionSelections.map((selection, index) =>
    normalizeQuestion(payload, selection, parsed?.questions?.[index], index)
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: "vision",
    summary: buildSummary(questions),
    questions,
  };
}

function normalizeQuestion(
  payload: GradeRequestPayload,
  selection: GradeRequestPayload["questionSelections"][number],
  raw: any,
  index: number
): QuestionResult {
  const resolvedQuestionNumber =
    selection.questionNumberHint ??
    (Number.isFinite(raw?.question_number) ? Number(raw.question_number) : null) ??
    selection.displayOrder ??
    index + 1;
  const answerPageMatch = resolveMatchedAnswerPage(
    payload.answerPages,
    Number.isFinite(raw?.matched_answer_page_number) ? Number(raw.matched_answer_page_number) : null,
    resolvedQuestionNumber
  );
  const rawQuestionType = normalizeQuestionType(raw?.question_type);
  const isCorrect = Boolean(raw?.is_correct);
  const maxScore = Math.max(1, toNumber(raw?.max_score, 1));
  const score = Math.max(0, Math.min(maxScore, toNumber(raw?.score, isCorrect ? maxScore : 0)));
  const normalizedDetectedHeaderText = normalizeReadableText(raw?.detected_header_text, "");
  const normalizedTextHint = normalizeReadableText(selection.extractedTextSnippet, "");
  const detectedMarks = Array.isArray(raw?.work_evidence?.detected_marks)
    ? raw.work_evidence.detected_marks.filter((item: unknown) => typeof item === "string")
    : [];
  const normalizedChoiceStudentAnswer = normalizeStudentAnswer(raw?.student_answer, "multiple-choice");
  const normalizedChoiceCorrectAnswer = normalizeCorrectAnswer(raw?.correct_answer, "multiple-choice");
  const questionType = inferQuestionType({
    rawQuestionType,
    detectedHeaderText: normalizedDetectedHeaderText,
    textHint: normalizedTextHint,
    studentAnswer: normalizedChoiceStudentAnswer,
    correctAnswer: normalizedChoiceCorrectAnswer,
    detectedMarks,
  });

  return {
    selectionId: selection.id,
    questionNumber: resolvedQuestionNumber,
    detectedHeaderText: toStringValue(
      normalizedDetectedHeaderText,
      normalizedTextHint || `문제 ${resolvedQuestionNumber}`
    ),
    questionType,
    studentAnswer: normalizeStudentAnswer(raw?.student_answer, questionType),
    correctAnswer: normalizeCorrectAnswer(raw?.correct_answer, questionType),
    isCorrect,
    score,
    maxScore,
    confidence: clamp(toNumber(raw?.confidence, 0.48), 0, 1),
    reviewRequired: Boolean(raw?.review_required),
    matchedAnswerPageNumber: answerPageMatch.pageNumber,
    matchedAnswerReason:
      toStringValue(
        raw?.matched_answer_reason,
        "문항 번호, 텍스트 힌트, 답지 페이지 후보를 함께 비교해 가장 가까운 답지 페이지를 찾았습니다."
      ) + answerPageMatch.reasonSuffix,
    answerRegion: normalizeBox(raw?.answer_region),
    explanationRegion: normalizeBox(raw?.explanation_region),
    workEvidence: {
      authenticity: normalizeAuthenticity(raw?.work_evidence?.authenticity),
      rationale: toStringValue(raw?.work_evidence?.rationale, "풀이 흔적이 충분하지 않아 보수적으로 판단했습니다."),
      extractedWork: toStringValue(raw?.work_evidence?.extracted_work, ""),
      detectedMarks,
    },
    feedback: {
      mistakeReason: toStringValue(raw?.feedback?.mistake_reason, "학생 답과 정답을 다시 확인해 주세요."),
      explanation: toStringValue(raw?.feedback?.explanation, "답지 해설 이미지를 다시 확인해 보세요."),
      recommendedReview: toStringValue(
        raw?.feedback?.recommended_review,
        "같은 유형 문제를 1~2문항 더 풀어 보며 개념을 확인해 보세요."
      ),
      conceptTags: Array.isArray(raw?.feedback?.concept_tags)
        ? raw.feedback.concept_tags.filter((item: unknown) => typeof item === "string").slice(0, 3)
        : [],
    },
  };
}

function buildFallbackResponse(payload: GradeRequestPayload, reason: string): GradeResponsePayload {
  const failure = classifyFallbackFailure(reason);
  const questions: QuestionResult[] = payload.questionSelections.map((selection, index) => {
    const questionNumber = selection.questionNumberHint ?? selection.displayOrder ?? index + 1;
    const answerPageMatch = resolveMatchedAnswerPage(
      payload.answerPages,
      payload.answerPages[index]?.pageNumber ?? null,
      questionNumber
    );

    return {
      selectionId: selection.id,
      questionNumber,
      detectedHeaderText: selection.extractedTextSnippet || `문제 ${questionNumber}`,
      questionType: inferFallbackQuestionType(payload, selection, answerPageMatch.pageNumber, questionNumber),
      studentAnswer: "",
      correctAnswer: "",
      isCorrect: false,
      score: 0,
      maxScore: 1,
      confidence: 0.18,
      reviewRequired: true,
      matchedAnswerPageNumber: answerPageMatch.pageNumber,
      matchedAnswerReason: `실제 채점 추출에 실패해 임시 답지 페이지를 연결했습니다.${answerPageMatch.reasonSuffix}`,
      answerRegion: { x: 0.08, y: 0.08, width: 0.34, height: 0.12 },
      explanationRegion: { x: 0.06, y: 0.16, width: 0.88, height: 0.72 },
      workEvidence: {
        authenticity: "unclear",
        rationale: "현재는 자동 풀이 흔적 판정을 완료하지 못했습니다.",
        extractedWork: "",
        detectedMarks: [],
      },
      feedback: {
        mistakeReason: failure.mistakeReason,
        explanation: failure.explanation,
        recommendedReview: failure.recommendedReview,
        conceptTags: failure.conceptTags,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    mode: "fallback",
    summary: buildSummary(questions),
    questions,
  };
}

function classifyFallbackFailure(rawReason: string) {
  const normalizedReason = extractFailureReason(rawReason);
  const shortDetail = summarizeFailureReason(normalizedReason);
  const retryDelaySeconds = extractRetryDelaySeconds(rawReason, normalizedReason);

  if (/GEMINI_API_KEY.*missing/i.test(normalizedReason)) {
    return {
      mistakeReason: "Gemini API 키가 설정되지 않아 실제 채점을 시작하지 못했습니다.",
      explanation: "서버에서 Gemini 호출 자체가 실행되지 않았습니다. 환경 변수에 GEMINI_API_KEY가 비어 있거나 배포 환경에 반영되지 않은 상태입니다.",
      recommendedReview: "로컬 .env 또는 Vercel 환경 변수의 GEMINI_API_KEY를 다시 확인해 주세요.",
      conceptTags: ["API 키 확인"],
    };
  }

  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|free_tier|RetryInfo|too many requests/i.test(normalizedReason)) {
    return {
      mistakeReason: "Gemini 무료 요청 한도에 걸려 이번 채점 요청이 거절되었습니다.",
      explanation:
        retryDelaySeconds !== null
          ? `모델 응답 문제가 아니라 무료 quota 문제입니다. 분당 요청 수를 넘겨 채점이 멈췄고, 약 ${retryDelaySeconds}초 뒤에 다시 시도할 수 있습니다.`
          : "모델 응답 문제가 아니라 무료 quota 문제입니다. 분당 요청 수를 넘겨 채점이 중간에 멈췄습니다.",
      recommendedReview:
        retryDelaySeconds !== null
          ? `약 ${retryDelaySeconds}초 정도 기다린 뒤 다시 시도하거나, 한 번에 보내는 요청 수를 줄여 주세요.`
          : "잠시 기다렸다가 다시 시도하거나, 한 번에 보내는 요청 수를 줄여 주세요.",
      conceptTags: ["무료 한도 초과"],
    };
  }

  if (/FUNCTION_PAYLOAD_TOO_LARGE|Request Entity Too Large|payload too large|request too large|request body too large/i.test(normalizedReason)) {
    return {
      mistakeReason: "채점 요청에 포함된 이미지나 데이터가 너무 커서 서버가 요청을 거절했습니다.",
      explanation: appendFailureDetail(
        "모델 해설 생성 전에 요청 크기 제한에 걸린 상태입니다. 선택한 페이지 수가 많거나 이미지가 너무 커서 한 번에 처리되지 않았습니다.",
        shortDetail
      ),
      recommendedReview: "문항 수나 답지 페이지 수를 줄이거나 이미지를 더 가볍게 만들어 다시 채점해 주세요.",
      conceptTags: ["요청 크기 초과"],
    };
  }

  if (/JSON parse failed|Unexpected end of JSON|double-quoted property name|Expected .* in JSON|JSON 텍스트를 찾지 못했습니다/i.test(normalizedReason)) {
    return {
      mistakeReason: "Gemini가 채점 결과를 깨진 JSON 형식으로 반환해 자동 판정을 끝까지 조립하지 못했습니다.",
      explanation: appendFailureDetail(
        "채점 요청은 나갔지만 모델 응답 형식이 망가져 결과를 읽어오지 못했습니다. 즉 정답 판정 로직보다 응답 파싱 단계에서 실패한 것입니다.",
        shortDetail
      ),
      recommendedReview: "같은 요청을 다시 시도해 보거나, 선택 문항 수를 줄여 응답 길이를 낮춘 뒤 다시 채점해 주세요.",
      conceptTags: ["응답 형식 오류"],
    };
  }

  if (/fetch failed|network|timeout|timed out|deadline|ECONNRESET|socket hang up/i.test(normalizedReason)) {
    return {
      mistakeReason: "Gemini 서버 응답을 안정적으로 받지 못해 채점을 완료하지 못했습니다.",
      explanation: appendFailureDetail(
        "모델이 완전한 응답을 돌려주기 전에 네트워크 또는 시간 제한 문제로 요청이 끊겼습니다.",
        shortDetail
      ),
      recommendedReview: "잠시 후 다시 시도해 주세요. 같은 문제가 반복되면 네트워크 상태와 배포 환경을 함께 확인해 주세요.",
      conceptTags: ["네트워크 오류"],
    };
  }

  return {
    mistakeReason: "자동 채점 결과를 완성하지 못했습니다.",
    explanation: appendFailureDetail(
      "모델 응답을 끝까지 해석하지 못해 이번 채점은 fallback 결과로 표시되었습니다.",
      shortDetail
    ),
    recommendedReview: "같은 요청을 다시 시도해 보고, 반복되면 입력 문항 수나 답지 페이지 구성을 줄여 주세요.",
    conceptTags: ["자동 채점 실패"],
  };
}

function extractFailureReason(rawReason: string) {
  const trimmed = rawReason.trim();

  if (!trimmed) {
    return "Unknown failure";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: {
        message?: string;
        status?: string;
        code?: number;
      };
      message?: string;
    };

    const pieces = [
      typeof parsed.error?.status === "string" ? parsed.error.status : "",
      typeof parsed.error?.message === "string" ? parsed.error.message : "",
      typeof parsed.message === "string" ? parsed.message : "",
    ].filter(Boolean);

    if (pieces.length > 0) {
      return pieces.join(" | ");
    }
  } catch {
    // Keep the original reason when the message is not JSON.
  }

  return trimmed;
}

function summarizeFailureReason(reason: string) {
  return reason
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/For more information.*$/i, "")
    .replace(/Please check your plan and billing details\.?/gi, "")
    .replace(/To monitor your current usage.*$/i, "")
    .replace(/\*.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function appendFailureDetail(message: string, detail: string) {
  if (!detail || detail === "Unknown failure") {
    return message;
  }

  return `${message} 세부 원인: ${detail}.`;
}

function extractRetryDelaySeconds(rawReason: string, normalizedReason: string) {
  try {
    const parsed = JSON.parse(rawReason) as {
      error?: {
        details?: Array<{
          retryDelay?: string;
        }>;
      };
    };
    const retryDelay = parsed.error?.details?.find((detail) => typeof detail?.retryDelay === "string")?.retryDelay;

    if (retryDelay) {
      const seconds = Number.parseInt(retryDelay.replace(/[^\d]/g, ""), 10);

      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    }
  } catch {
    // Ignore parse failures and fall back to regex extraction.
  }

  const retryMatch = normalizedReason.match(/retry in\s+(\d+)(?:\.\d+)?s?/i) ?? normalizedReason.match(/(\d+)초/);

  if (!retryMatch) {
    return null;
  }

  const seconds = Number.parseInt(retryMatch[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function inferFallbackQuestionType(
  payload: GradeRequestPayload,
  selection: GradeRequestPayload["questionSelections"][number],
  matchedAnswerPageNumber: number | null,
  questionNumber: number
) {
  const matchedAnswerPage =
    matchedAnswerPageNumber !== null
      ? payload.answerPages.find((page) => page.pageNumber === matchedAnswerPageNumber) ?? null
      : null;
  const selectionText = normalizeReadableText(selection.extractedTextSnippet, "");
  const answerText = normalizeReadableText(matchedAnswerPage?.extractedTextSnippet, "");
  const hasMatchingAnchor = Boolean(
    matchedAnswerPage?.answerAnchors?.some((anchor) => anchor.questionNumber === questionNumber)
  );

  return inferQuestionType({
    rawQuestionType: "short-answer",
    detectedHeaderText: selectionText,
    textHint: [selectionText, answerText].filter(Boolean).join(" "),
    studentAnswer: "",
    correctAnswer: "",
    detectedMarks: hasMatchingAnchor ? ["choice"] : [],
  });
}

function normalizeQuestionType(value: unknown): QuestionType {
  return value === "multiple-choice" || value === "short-answer" || value === "essay" ? value : "short-answer";
}

function inferQuestionType(input: {
  rawQuestionType: QuestionType;
  detectedHeaderText: string;
  textHint: string;
  studentAnswer: string;
  correctAnswer: string;
  detectedMarks: string[];
}): QuestionType {
  if (input.rawQuestionType === "essay") {
    return "essay";
  }

  if (input.rawQuestionType === "multiple-choice") {
    return "multiple-choice";
  }

  const textPool = [input.detectedHeaderText, input.textHint].filter(Boolean).join(" ");
  const hasChoiceGlyphs = /[\u2460-\u2473\u2776-\u277f]/u.test(textPool);
  const choiceMarkerCount = countChoiceMarkers(textPool);
  const hasChoicePattern = choiceMarkerCount >= 3;
  const hasDenseChoiceSequence = hasChoiceSequence(textPool);
  const numericChoiceAnswer = isChoiceAnswer(input.studentAnswer) || isChoiceAnswer(input.correctAnswer);
  const hasChoiceMark = input.detectedMarks.some((mark) => /check|circle|slash|mark|choice|v/i.test(mark));
  const looksLikeObjectivePrompt = /(고르시오|알맞은것|옳은것|보기에서|다음중|다음 중)/.test(textPool.replace(/\s+/g, ""));

  if (hasChoiceGlyphs || hasChoicePattern || hasDenseChoiceSequence) {
    return "multiple-choice";
  }

  if (numericChoiceAnswer && (hasChoiceMark || choiceMarkerCount >= 2 || looksLikeObjectivePrompt)) {
    return "multiple-choice";
  }

  if (numericChoiceAnswer && textPool.length >= 16) {
    return "multiple-choice";
  }

  if (hasChoiceMark && choiceMarkerCount >= 2) {
    return "multiple-choice";
  }

  if (looksLikeObjectivePrompt && choiceMarkerCount >= 2) {
    return "multiple-choice";
  }

  return input.rawQuestionType;
}

function normalizeAuthenticity(value: unknown): WorkAuthenticity {
  return value === "solved" || value === "guessed" || value === "blank" || value === "unclear" ? value : "unclear";
}

function normalizeBox(value: any): BoundingBox | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const x = clamp(toNumber(value.x, 0.06), 0, 1);
  const y = clamp(toNumber(value.y, 0.06), 0, 1);
  const width = clamp(toNumber(value.width, 0.88), 0.04, 1 - x);
  const height = clamp(toNumber(value.height, 0.26), 0.04, 1 - y);

  return { x, y, width, height };
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeStudentAnswer(value: unknown, questionType: QuestionType) {
  const raw = toStringValue(value, "");

  if (questionType !== "multiple-choice") {
    return raw;
  }

  return normalizeChoiceAnswer(raw);
}

function normalizeCorrectAnswer(value: unknown, questionType: QuestionType) {
  const raw = toStringValue(value, "");

  if (questionType !== "multiple-choice") {
    return raw;
  }

  return normalizeChoiceAnswer(raw);
}

function normalizeChoiceAnswer(value: string) {
  const compact = value.replace(/\s+/g, "");

  if (!compact) {
    return "";
  }

  const circledMap: Record<string, string> = {
    "①": "1",
    "②": "2",
    "③": "3",
    "④": "4",
    "⑤": "5",
  };

  if (circledMap[compact]) {
    return circledMap[compact];
  }

  const digitMatch = compact.match(/[1-5]/);
  return digitMatch?.[0] ?? compact;
}

function isChoiceAnswer(value: string) {
  return /^[1-5]$/.test(value.trim());
}

function countChoiceMarkers(value: string) {
  if (!value) {
    return 0;
  }

  const normalized = value
    .replace(/[\u2460]/gu, " 1 ")
    .replace(/[\u2461]/gu, " 2 ")
    .replace(/[\u2462]/gu, " 3 ")
    .replace(/[\u2463]/gu, " 4 ")
    .replace(/[\u2464]/gu, " 5 ");
  const matches = normalized.match(/(?:^|[\s(])(?:1|2|3|4|5)(?:[.)\-:]|(?=\s)|(?=[^\d]))/gu);
  const unique = new Set(
    (matches ?? [])
      .map((match) => match.match(/[1-5]/)?.[0] ?? "")
      .filter(Boolean)
  );

  return unique.size;
}

function hasChoiceSequence(value: string) {
  if (!value) {
    return false;
  }

  const compact = value
    .replace(/[\u2460]/gu, "1")
    .replace(/[\u2461]/gu, "2")
    .replace(/[\u2462]/gu, "3")
    .replace(/[\u2463]/gu, "4")
    .replace(/[\u2464]/gu, "5")
    .replace(/\s+/g, "")
    .replace(/[^\d().\-]/g, "");

  return (
    /1[.)-]?2[.)-]?3[.)-]?4(?:[.)-]?5)?/.test(compact) ||
    /1[.)].{0,18}2[.)].{0,18}3[.)]/.test(compact)
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getAnchorQuestionNumbers(page: AnswerPagePayload) {
  return (page.answerAnchors ?? [])
    .map((anchor) => anchor.questionNumber)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function pageContainsQuestionNumber(page: AnswerPagePayload, questionNumber: number | null | undefined) {
  if (!questionNumber) {
    return false;
  }

  return getAnchorQuestionNumbers(page).includes(questionNumber);
}

function resolveMatchedAnswerPage(
  answerPages: AnswerPagePayload[],
  rawPageNumber: number | null,
  questionNumber: number | null
) {
  const rawPage = rawPageNumber ? answerPages.find((page) => page.pageNumber === rawPageNumber) ?? null : null;
  const anchorPage = findBestAnswerPageByAnchors(answerPages, questionNumber);

  if (rawPage && pageContainsQuestionNumber(rawPage, questionNumber)) {
    return { pageNumber: rawPage.pageNumber, reasonSuffix: "" };
  }

  if (anchorPage && (!rawPage || anchorPage.pageNumber !== rawPage.pageNumber)) {
    return {
      pageNumber: anchorPage.pageNumber,
      reasonSuffix: ` (local anchor match used for question ${questionNumber ?? "unknown"})`,
    };
  }

  if (rawPage) {
    return { pageNumber: rawPage.pageNumber, reasonSuffix: "" };
  }

  if (anchorPage) {
    return {
      pageNumber: anchorPage.pageNumber,
      reasonSuffix: ` (local anchor fallback used for question ${questionNumber ?? "unknown"})`,
    };
  }

  return {
    pageNumber: answerPages[0]?.pageNumber ?? null,
    reasonSuffix: answerPages.length > 0 ? " (fallback to the first answer page)" : "",
  };
}
