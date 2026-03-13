import { NextResponse } from "next/server";
import { imagePartFromDataUrl, type GeminiPart, generateGeminiJson } from "@/lib/gemini";
import { rankAnswerPageCandidates } from "@/lib/page-matching";
import { buildSummary } from "@/lib/summary";
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
당신은 시험지 자동 채점 보조 시스템입니다.
이번 호출에서는 기본 채점만 수행합니다.

목표:
1. 문제 영역과 답안 페이지를 정확하게 매칭합니다.
2. 학생의 답이 정답 리스트에 있는지 확인하고 is_correct를 true 또는 false로만 판단합니다.
3. 현재 화면에 남아 있는 풀이와 최종 표기만 보고 authenticity를 solved / guessed / blank / unclear 중 하나로 고릅니다.
4. 지운 흔적, 덧칠, 수정 흔적은 최종 풀이로 명확할 때만 참고하고, 애매하면 무시합니다.
5. 해설 영역과 정답 영역의 대략적인 박스를 찾습니다.
6. feedback은 아주 짧게만 작성합니다.

중요 제약:
- 반드시 JSON만 반환합니다.
- 보이지 않는 보기, 기호, 문장, 조건을 추측하지 않습니다.
- selection_id 순서대로 questions 배열을 채웁니다.
- 정오 판단의 핵심은 "학생 답이 정답 리스트에 포함되는지 여부"입니다.
- feedback.mistake_reason은 1문장 이내로 작성합니다.
- feedback.explanation은 2문장 이내로 작성합니다.
- feedback.recommended_review는 1문장 이내로 작성합니다.
- feedback.concept_tags는 최대 3개까지만 넣습니다.
- 확신이 낮으면 review_required를 true로 둡니다.
- answer_region과 explanation_region은 0~1 정규화 좌표로 반환합니다.
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as GradeRequestPayload;

  if (!payload.questionSelections?.length || !payload.answerPages?.length) {
    return new NextResponse("문제 영역과 답안 페이지를 먼저 선택해 주세요.", { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return NextResponse.json(buildFallbackResponse(payload, "GEMINI_API_KEY가 없어 데모 결과를 반환했습니다."));
  }

  try {
    const parsed = await generateGeminiJson<{ questions?: unknown[] }>({
      apiKey,
      model,
      systemInstruction: SYSTEM_PROMPT,
      parts: buildUserParts(payload),
      responseJsonSchema: GRADE_RESPONSE_SCHEMA,
      maxOutputTokens: estimateOutputTokens(payload.questionSelections.length),
      temperature: 0.05
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
        "선택된 문제별로 가장 가능성 높은 답안 페이지 후보를 비교해 기본 채점만 수행해 주세요.",
        "오답 원인 설명은 길게 쓰지 말고 정오 판단과 짧은 메모만 남겨 주세요."
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
        `text_hint=${selection.extractedTextSnippet || "없음"}`,
        "답안 후보 페이지:",
        candidateHints || "- 없음"
      ].join("\n")
    });

    parts.push(imagePartFromDataUrl(selection.snapshotDataUrl));
    parts.push({
      text: `문제 전체 페이지 참고 이미지 (selection_id=${selection.id})`
    });
    parts.push(imagePartFromDataUrl(selection.pageImageDataUrl));

    candidatePages.forEach((page, candidateIndex) => {
      parts.push({
        text: `답안 후보 page=${page.pageNumber}, text_hint=${page.extractedTextSnippet || "없음"}, primary_candidate=${candidateIndex === 0}`
      });
      parts.push(imagePartFromDataUrl(page.pageImageDataUrl));
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
  const questionType = normalizeQuestionType(raw?.question_type);
  const isCorrect = Boolean(raw?.is_correct);
  const maxScore = Math.max(1, toNumber(raw?.max_score, 1));
  const score = Math.max(0, Math.min(maxScore, toNumber(raw?.score, isCorrect ? maxScore : 0)));

  return {
    selectionId: selection.id,
    questionNumber: Number.isFinite(raw?.question_number) ? raw.question_number : index + 1,
    detectedHeaderText: toStringValue(raw?.detected_header_text, selection.extractedTextSnippet || `문제 페이지 ${selection.pageNumber}`),
    questionType,
    studentAnswer: toStringValue(raw?.student_answer, ""),
    correctAnswer: toStringValue(raw?.correct_answer, ""),
    isCorrect,
    score,
    maxScore,
    confidence: clamp(toNumber(raw?.confidence, 0.48), 0, 1),
    reviewRequired: Boolean(raw?.review_required),
    matchedAnswerPageNumber: answerPageNumber,
    matchedAnswerReason: toStringValue(
      raw?.matched_answer_reason,
      "페이지 번호, 상단 제목, 문항 배열을 함께 비교해 가장 가까운 답안 페이지로 매칭했습니다."
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
      explanation: toStringValue(raw?.feedback?.explanation, "답지 해설 이미지를 함께 보며 다시 확인해 보세요."),
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
    questionNumber: index + 1,
    detectedHeaderText: selection.extractedTextSnippet || `문제 페이지 ${selection.pageNumber}`,
    questionType: "short-answer",
    studentAnswer: "",
    correctAnswer: "",
    isCorrect: false,
    score: 0,
    maxScore: 1,
    confidence: 0.18,
    reviewRequired: true,
    matchedAnswerPageNumber: payload.answerPages[index]?.pageNumber ?? payload.answerPages[0]?.pageNumber ?? null,
    matchedAnswerReason: "실제 채점 호출이 실패해 첫 번째 후보 페이지를 임시로 매칭했습니다.",
    answerRegion: { x: 0.08, y: 0.08, width: 0.34, height: 0.12 },
    explanationRegion: { x: 0.06, y: 0.16, width: 0.88, height: 0.72 },
    workEvidence: {
      authenticity: "unclear",
      rationale: "현재는 자동 풀이 흔적 판정이 비활성화되어 있습니다.",
      extractedWork: "",
      detectedMarks: []
    },
    feedback: {
      mistakeReason: "실제 정오 판정을 완료하지 못했습니다.",
      explanation: `환경 설정이 완전하지 않아 데모 결과를 반환했습니다. 현재 메시지: ${reason}`,
      recommendedReview: "환경 변수를 확인한 뒤 다시 채점해 주세요.",
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
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
