import { NextResponse } from "next/server";
import { imagePartFromDataUrl, type GeminiPart, generateGeminiJson } from "@/lib/gemini";
import { rankAnswerPageCandidates } from "@/lib/page-matching";
import { buildSummary } from "@/lib/summary";
import { normalizeReadableText } from "@/lib/text-quality";
import type {
  BoundingBox,
  GradeRequestPayload,
  GradeResponsePayload,
  QuestionResult,
  QuestionType,
  WorkAuthenticity
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
          "feedback"
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
              height: { type: "number" }
            }
          },
          explanation_region: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "width", "height"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" }
            }
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
                items: { type: "string" }
              }
            }
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
                items: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
} as const;

const SYSTEM_PROMPT = `
You grade scanned exam pages.
Return JSON only.

Goals:
1. Match each question image to the most likely answer/explanation page.
2. For multiple-choice questions, detect the student's selected option number from visible marks.
3. Judge correctness only by whether the student's final answer is in the answer list.
4. Classify visible work as solved / guessed / blank / unclear.
5. Ignore erased marks or ambiguous overwritten traces.
6. Return tight normalized boxes for the answer region and explanation region.
7. Keep feedback short.

Rules:
- For multiple-choice, if the student placed a visible V mark, check mark, slash, circle, or emphasis near a choice, student_answer must be the option number only.
- Example: a mark near ④ means student_answer="4". A mark near ② means student_answer="2".
- If a multiple-choice mark is clearly visible, do not return blank or "미인식".
- For multiple-choice, answer_region should tightly cover the chosen option and its mark.
- Do not invent symbols, choices, or text you cannot see.
- Keep question order aligned to selection_id order.
- Broken OCR text does not matter if the selected option mark is visually clear.
- mistake_reason: 1 sentence max.
- explanation: 2 sentences max.
- recommended_review: 1 sentence max.
- concept_tags: max 3.
- Set review_required=true when confidence is low.
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as GradeRequestPayload;

  if (!payload.questionSelections?.length || !payload.answerPages?.length) {
    return new NextResponse("문제 페이지와 답안 페이지를 먼저 선택해 주세요.", { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return NextResponse.json(buildFallbackResponse(payload, "GEMINI_API_KEY가 없어 데모 결과를 반환합니다."));
  }

  try {
    const parsed = await generateGeminiJson<{ questions?: unknown[] }>({
      apiKey,
      model,
      systemInstruction: SYSTEM_PROMPT,
      parts: buildUserParts(payload),
      responseJsonSchema: GRADE_RESPONSE_SCHEMA,
      maxOutputTokens: estimateOutputTokens(payload.questionSelections.length),
      temperature: 0
    });

    return NextResponse.json(normalizeResponse(payload, parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : "자동 채점 중 오류가 발생했습니다.";
    return NextResponse.json(buildFallbackResponse(payload, message));
  }
}

function buildUserParts(payload: GradeRequestPayload): GeminiPart[] {
  const parts: GeminiPart[] = [
    {
      text: [
        `시험명: ${payload.metadata.examName || "미입력"}`,
        `과목: ${payload.metadata.subject}`,
        `난이도: ${payload.metadata.difficulty}`,
        `풀이 시간: ${payload.metadata.durationMinutes ?? "미입력"}분`,
        `시험 날짜: ${payload.metadata.takenAt}`,
        "",
        "문제별로 가장 가능성 높은 답안 후보 페이지를 비교해서 기본 채점만 진행해 주세요."
      ].join("\n")
    }
  ];

  payload.questionSelections.forEach((selection, index) => {
    const rankedCandidates = rankAnswerPageCandidates(selection, payload.answerPages);
    const candidatePages = rankedCandidates.slice(0, MAX_CANDIDATE_PAGES).map((item) => item.page);
    const candidateHints = rankedCandidates
      .slice(0, MAX_CANDIDATE_PAGES)
      .map((item) => `- page=${item.page.pageNumber}, score=${item.score.toFixed(2)}, reasons=${item.reasons.join(" / ")}`)
      .join("\n");

    parts.push({
      text: [
        `question_index=${index + 1}`,
        `selection_id=${selection.id}`,
        `question_page=${selection.pageNumber}`,
        `question_number_hint=${selection.questionNumberHint ?? "unknown"}`,
        `text_hint=${selection.extractedTextSnippet || "없음"}`,
        "multiple_choice_hint=객관식이면 문제 이미지에서 체크/V/동그라미가 붙은 선택지 번호만 student_answer로 반환하세요.",
        "answer_page_candidates:",
        candidateHints || "- 없음"
      ].join("\n")
    });

    parts.push(imagePartFromDataUrl(selection.analysisDataUrl ?? selection.snapshotDataUrl));

    candidatePages.forEach((page, candidateIndex) => {
      parts.push({
        text: `answer_candidate page=${page.pageNumber}, text_hint=${page.extractedTextSnippet || "없음"}, primary_candidate=${candidateIndex === 0}`
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
    questions
  };
}

function normalizeQuestion(
  payload: GradeRequestPayload,
  selection: GradeRequestPayload["questionSelections"][number],
  raw: any,
  index: number
): QuestionResult {
  const answerPageNumber = payload.answerPages.some((page) => page.pageNumber === raw?.matched_answer_page_number)
    ? raw.matched_answer_page_number
    : (payload.answerPages[0]?.pageNumber ?? null);
  const rawQuestionType = normalizeQuestionType(raw?.question_type);
  const isCorrect = Boolean(raw?.is_correct);
  const maxScore = Math.max(1, toNumber(raw?.max_score, 1));
  const score = Math.max(0, Math.min(maxScore, toNumber(raw?.score, isCorrect ? maxScore : 0)));
  const resolvedQuestionNumber =
    selection.displayOrder ??
    selection.questionNumberHint ??
    (Number.isFinite(raw?.question_number) ? Number(raw.question_number) : index + 1);
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
    detectedMarks
  });

  return {
    selectionId: selection.id,
    questionNumber: resolvedQuestionNumber,
    detectedHeaderText: toStringValue(
      normalizeReadableText(raw?.detected_header_text, ""),
      normalizeReadableText(selection.extractedTextSnippet, "") || `문제 ${resolvedQuestionNumber}`
    ),
    questionType,
    studentAnswer: normalizeStudentAnswer(raw?.student_answer, questionType),
    correctAnswer: normalizeCorrectAnswer(raw?.correct_answer, questionType),
    isCorrect,
    score,
    maxScore,
    confidence: clamp(toNumber(raw?.confidence, 0.48), 0, 1),
    reviewRequired: Boolean(raw?.review_required),
    matchedAnswerPageNumber: answerPageNumber,
    matchedAnswerReason: toStringValue(
      raw?.matched_answer_reason,
      "페이지 번호, 상단 텍스트, 문항 단서를 바탕으로 가장 가까운 답안 페이지로 매칭했습니다."
    ),
    answerRegion: normalizeBox(raw?.answer_region),
    explanationRegion: normalizeBox(raw?.explanation_region),
    workEvidence: {
      authenticity: normalizeAuthenticity(raw?.work_evidence?.authenticity),
      rationale: toStringValue(raw?.work_evidence?.rationale, "풀이 흔적이 충분하지 않아 보수적으로 판단했습니다."),
      extractedWork: toStringValue(raw?.work_evidence?.extracted_work, ""),
      detectedMarks: Array.isArray(raw?.work_evidence?.detected_marks)
        ? raw.work_evidence.detected_marks.filter((item: unknown) => typeof item === "string")
        : []
    },
    feedback: {
      mistakeReason: toStringValue(raw?.feedback?.mistake_reason, "답안을 다시 한 번 확인해 주세요."),
      explanation: toStringValue(raw?.feedback?.explanation, "답지 해설 이미지를 함께 보고 다시 확인해 보세요."),
      recommendedReview: toStringValue(raw?.feedback?.recommended_review, "같은 유형 문제를 1~2문항 더 풀어보는 것을 추천합니다."),
      conceptTags: Array.isArray(raw?.feedback?.concept_tags)
        ? raw.feedback.concept_tags.filter((item: unknown) => typeof item === "string").slice(0, 3)
        : []
    }
  };
}

function buildFallbackResponse(payload: GradeRequestPayload, reason: string): GradeResponsePayload {
  const questions: QuestionResult[] = payload.questionSelections.map((selection, index) => ({
    selectionId: selection.id,
    questionNumber: selection.displayOrder ?? selection.questionNumberHint ?? index + 1,
    detectedHeaderText: selection.extractedTextSnippet || `문제 ${selection.displayOrder ?? selection.questionNumberHint ?? index + 1}`,
    questionType: "short-answer",
    studentAnswer: "",
    correctAnswer: "",
    isCorrect: false,
    score: 0,
    maxScore: 1,
    confidence: 0.18,
    reviewRequired: true,
    matchedAnswerPageNumber: payload.answerPages[index]?.pageNumber ?? payload.answerPages[0]?.pageNumber ?? null,
    matchedAnswerReason: "실제 채점 호출에 실패해 첫 번째 답안 후보 페이지를 임시로 연결했습니다.",
    answerRegion: { x: 0.08, y: 0.08, width: 0.34, height: 0.12 },
    explanationRegion: { x: 0.06, y: 0.16, width: 0.88, height: 0.72 },
    workEvidence: {
      authenticity: "unclear",
      rationale: "현재는 자동 풀이 흔적 판정이 완료되지 않았습니다.",
      extractedWork: "",
      detectedMarks: []
    },
    feedback: {
      mistakeReason: "실제 정오 판정이 완료되지 않았습니다.",
      explanation: `환경 설정 또는 요청 크기 문제로 데모 결과를 반환했습니다. 현재 메시지: ${reason}`,
      recommendedReview: "설정을 확인한 뒤 다시 채점해 주세요.",
      conceptTags: ["설정 확인 필요"]
    }
  }));

  return {
    generatedAt: new Date().toISOString(),
    mode: "fallback",
    summary: buildSummary(questions),
    questions
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
  const hasChoiceGlyphs = /[\u2460-\u2473\u2776-\u277F]/u.test(textPool);
  const hasChoicePattern = countChoiceMarkers(textPool) >= 3;
  const numericChoiceAnswer = isChoiceAnswer(input.studentAnswer) || isChoiceAnswer(input.correctAnswer);
  const hasChoiceMark = input.detectedMarks.some((mark) => /check|circle|slash|mark|선택|체크|브이|v/i.test(mark));

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
    "⑤": "5"
  };

  if (circledMap[compact]) {
    return circledMap[compact];
  }

  const digitMatch = compact.match(/[1-5]/);

  if (digitMatch) {
    return digitMatch[0];
  }

  return compact;
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
