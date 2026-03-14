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
    return NextResponse.json(buildFallbackResponse(payload, "GEMINI_API_KEY is missing."));
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
    return NextResponse.json(buildFallbackResponse(payload, message));
  }
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
    selection.displayOrder ??
    selection.questionNumberHint ??
    (Number.isFinite(raw?.question_number) ? Number(raw.question_number) : index + 1);
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
  const questions: QuestionResult[] = payload.questionSelections.map((selection, index) => {
    const questionNumber = selection.displayOrder ?? selection.questionNumberHint ?? index + 1;
    const answerPageMatch = resolveMatchedAnswerPage(
      payload.answerPages,
      payload.answerPages[index]?.pageNumber ?? null,
      questionNumber
    );

    return {
      selectionId: selection.id,
      questionNumber,
      detectedHeaderText: selection.extractedTextSnippet || `문제 ${questionNumber}`,
      questionType: "short-answer",
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
        mistakeReason: "실제 정오 판정을 완료하지 못했습니다.",
        explanation: "일시적인 모델 응답 문제로 이번 채점은 자동 해설을 완성하지 못했습니다. 다시 채점하면 정상 인식될 수 있습니다.",
        recommendedReview: "환경 변수를 확인한 뒤 다시 채점해 주세요.",
        conceptTags: ["설정 확인 필요"],
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
  const hasChoicePattern = countChoiceMarkers(textPool) >= 3;
  const numericChoiceAnswer = isChoiceAnswer(input.studentAnswer) || isChoiceAnswer(input.correctAnswer);
  const hasChoiceMark = input.detectedMarks.some((mark) => /check|circle|slash|mark|choice|v/i.test(mark));

  if (hasChoiceGlyphs || hasChoicePattern) {
    return "multiple-choice";
  }

  if (numericChoiceAnswer && hasChoiceMark) {
    return "multiple-choice";
  }

  if (numericChoiceAnswer && textPool.length >= 16) {
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

  const matches = value.match(/[\u2460-\u2464]|(?:^|[\s(])(?:1|2|3|4|5)(?:[.)]|(?=\s))/gu);
  return matches?.length ?? 0;
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
