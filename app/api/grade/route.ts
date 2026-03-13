import { NextResponse } from "next/server";
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

const SYSTEM_PROMPT = `
You are an exam-grading orchestrator for Korean study sheets.
Your job is to align each selected question crop with the correct answer page, extract question number and header clues, recognize the student's answer, decide whether the student genuinely attempted the problem or likely guessed, and produce concise Korean feedback.

Rules:
1. Match carefully across question page number, visible header text, problem numbering, layout cues, and answer choice markers.
2. Distinguish question_type among multiple-choice, short-answer, essay.
3. For multiple-choice, inspect circles/check marks and infer the chosen option.
4. For short-answer, inspect boxed numeric or textual answers.
5. For essay, inspect full written sentences or formulas.
6. work_evidence.authenticity must be one of solved, guessed, blank, unclear.
7. If recognition is uncertain, set review_required to true and lower confidence.
8. explanation_region and answer_region must be normalized 0..1 bounding boxes relative to the matched answer page image.
9. Return JSON only. No markdown fences. No extra prose.

Return shape:
{
  "questions": [
    {
      "selection_id": "string",
      "question_number": 1,
      "detected_header_text": "중단원 점검 p.34",
      "question_type": "multiple-choice",
      "student_answer": "3번",
      "correct_answer": "2번",
      "is_correct": false,
      "score": 0,
      "max_score": 1,
      "confidence": 0.84,
      "review_required": false,
      "matched_answer_page_number": 7,
      "matched_answer_reason": "문제 상단의 p.34 / 11번이 답지 7페이지의 11번과 일치",
      "answer_region": { "x": 0.12, "y": 0.18, "width": 0.3, "height": 0.12 },
      "explanation_region": { "x": 0.08, "y": 0.22, "width": 0.84, "height": 0.28 },
      "work_evidence": {
        "authenticity": "solved",
        "rationale": "풀이식이 2줄 이상 보이고 최종답 표기가 있음",
        "extracted_work": "x^2-5x+6=0 ...",
        "detected_marks": ["동그라미", "지우개 흔적"]
      },
      "feedback": {
        "mistake_reason": "인수분해 뒤 근을 하나만 선택함",
        "explanation": "정답은 두 근을 모두 고려해 조건을 만족하는 값을 고르는 방식입니다.",
        "recommended_review": "인수분해 후 해 검산 과정을 다시 연습하세요.",
        "concept_tags": ["인수분해", "근의 판별"]
      }
    }
  ]
}
`;

export async function POST(request: Request) {
  const payload = (await request.json()) as GradeRequestPayload;

  if (!payload.questionSelections?.length || !payload.answerPages?.length) {
    return new NextResponse("문제 영역과 답안 페이지가 필요합니다.", { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(buildFallbackResponse(payload, "OPENAI_API_KEY가 없어 로컬 데모 결과를 반환했습니다."));
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL ?? "gpt-4.1",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }]
          },
          {
            role: "user",
            content: buildUserContent(payload)
          }
        ],
        max_output_tokens: 5000
      })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const raw = await response.json();
    const outputText = extractOutputText(raw);

    if (!outputText) {
      throw new Error("Vision API 응답에서 텍스트 결과를 찾지 못했습니다.");
    }

    const parsed = JSON.parse(stripJsonFence(outputText));
    const normalized = normalizeResponse(payload, parsed);
    return NextResponse.json(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vision 채점에 실패했습니다.";
    return NextResponse.json(buildFallbackResponse(payload, message));
  }
}

function buildUserContent(payload: GradeRequestPayload) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: [
        `시험명: ${payload.metadata.examName || "미입력"}`,
        `과목: ${payload.metadata.subject}`,
        `난이도: ${payload.metadata.difficulty}`,
        `풀이 시간: ${payload.metadata.durationMinutes ?? "미입력"}분`,
        `시험 날짜: ${payload.metadata.takenAt}`,
        "",
        "질문 선택 영역들을 문제 번호 순으로 정렬하고, 각 영역마다 가장 적절한 답안/해설 페이지를 찾아 주세요.",
        "OCR 단서가 약할 경우 상단 제목, 페이지 번호, 문항 번호, 시각적 배치를 함께 사용해 보수적으로 판단하세요."
      ].join("\n")
    }
  ];

  payload.questionSelections.forEach((selection, index) => {
    const rankedCandidates = rankAnswerPageCandidates(selection, payload.answerPages);
    const candidatePages = (payload.answerPages.length <= 8 ? rankedCandidates : rankedCandidates.slice(0, 5)).map((item) => item.page);
    const candidateHints = rankedCandidates
      .slice(0, Math.min(5, rankedCandidates.length))
      .map((item) => `- answer_page=${item.page.pageNumber}, heuristic_score=${item.score.toFixed(2)}, reasons=${item.reasons.join(" / ")}`)
      .join("\n");

    content.push({
      type: "input_text",
      text: [
        `문제 선택 ${index + 1} / selection_id=${selection.id} / question_page=${selection.pageNumber} / text_hint=${selection.extractedTextSnippet || "없음"}`,
        "다음은 로컬 휴리스틱으로 추린 답안 후보 순위입니다.",
        candidateHints
      ].join("\n")
    });
    content.push({
      type: "input_image",
      image_url: selection.snapshotDataUrl,
      detail: "high"
    });
    content.push({
      type: "input_text",
      text: `문제 선택 ${index + 1}의 전체 페이지`
    });
    content.push({
      type: "input_image",
      image_url: selection.pageImageDataUrl,
      detail: "low"
    });
    candidatePages.forEach((page) => {
      content.push({
        type: "input_text",
        text: `답안 후보 page=${page.pageNumber} / text_hint=${page.extractedTextSnippet || "없음"}`
      });
      content.push({
        type: "input_image",
        image_url: page.pageImageDataUrl,
        detail: "high"
      });
    });
  });

  return content;
}

function extractOutputText(raw: unknown): string {
  if (raw && typeof raw === "object" && "output_text" in raw && typeof raw.output_text === "string") {
    return raw.output_text;
  }

  if (raw && typeof raw === "object" && "output" in raw && Array.isArray(raw.output)) {
    const texts = raw.output.flatMap((item: any) =>
      Array.isArray(item.content)
        ? item.content
            .filter((contentItem: any) => typeof contentItem?.text === "string")
            .map((contentItem: any) => contentItem.text as string)
        : []
    );
    return texts.join("\n").trim();
  }

  return "";
}

function stripJsonFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeResponse(payload: GradeRequestPayload, parsed: any): GradeResponsePayload {
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

function normalizeQuestion(payload: GradeRequestPayload, selection: GradeRequestPayload["questionSelections"][number], raw: any, index: number): QuestionResult {
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
    matchedAnswerReason: toStringValue(raw?.matched_answer_reason, "페이지/상단 헤더/문항 위치 단서를 종합해 매칭했습니다."),
    answerRegion: normalizeBox(raw?.answer_region),
    explanationRegion: normalizeBox(raw?.explanation_region),
    workEvidence: {
      authenticity: normalizeAuthenticity(raw?.work_evidence?.authenticity),
      rationale: toStringValue(raw?.work_evidence?.rationale, "풀이 흔적을 명확히 읽지 못해 보수적으로 판정했습니다."),
      extractedWork: toStringValue(raw?.work_evidence?.extracted_work, ""),
      detectedMarks: Array.isArray(raw?.work_evidence?.detected_marks)
        ? raw.work_evidence.detected_marks.filter((item: unknown) => typeof item === "string")
        : []
    },
    feedback: {
      mistakeReason: toStringValue(raw?.feedback?.mistake_reason, "오답 원인을 충분히 특정하지 못해 다시 확인이 필요합니다."),
      explanation: toStringValue(raw?.feedback?.explanation, "답안지 해설을 직접 확인해 한 번 더 검토해 주세요."),
      recommendedReview: toStringValue(raw?.feedback?.recommended_review, "틀린 문제를 같은 유형끼리 다시 풀어보세요."),
      conceptTags: Array.isArray(raw?.feedback?.concept_tags)
        ? raw.feedback.concept_tags.filter((item: unknown) => typeof item === "string")
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
    matchedAnswerReason: "실제 Vision OCR을 사용하지 못해 첫 번째 후보 페이지를 임시 매칭했습니다.",
    answerRegion: { x: 0.08, y: 0.08, width: 0.34, height: 0.12 },
    explanationRegion: { x: 0.06, y: 0.16, width: 0.88, height: 0.72 },
    workEvidence: {
      authenticity: "unclear",
      rationale: "현재는 데모 모드이므로 실제 풀이 흔적 판정이 비활성화되어 있습니다.",
      extractedWork: "",
      detectedMarks: []
    },
    feedback: {
      mistakeReason: "Vision 모델이 연결되지 않아 실제 정오 판정을 수행하지 못했습니다.",
      explanation: `환경 설정 후에는 선택한 문제와 답안 페이지를 비교해 자동 해설을 채웁니다. 현재 메시지: ${reason}`,
      recommendedReview: "`.env`에 OPENAI_API_KEY를 넣은 뒤 다시 채점해 주세요.",
      conceptTags: ["수동 검토 필요"]
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
