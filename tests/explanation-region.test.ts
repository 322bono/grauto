import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalExplanationRects } from "@/lib/explanation-region";
import type { AnswerPagePayload, QuestionResult } from "@/lib/types";

function buildQuestion(selectionId: string, questionNumber: number): QuestionResult {
  return {
    selectionId,
    questionNumber,
    detectedHeaderText: `${questionNumber}번 문제`,
    questionType: "multiple-choice",
    studentAnswer: "4",
    correctAnswer: "4",
    isCorrect: true,
    score: 1,
    maxScore: 1,
    confidence: 0.9,
    reviewRequired: false,
    matchedAnswerPageNumber: 1,
    matchedAnswerReason: "test",
    answerRegion: { x: 0.1, y: 0.1, width: 0.2, height: 0.12 },
    explanationRegion: { x: 0.1, y: 0.22, width: 0.3, height: 0.2 },
    workEvidence: {
      authenticity: "solved",
      rationale: "test",
      extractedWork: "",
      detectedMarks: [],
    },
    feedback: {
      mistakeReason: "",
      explanation: "",
      recommendedReview: "",
      conceptTags: [],
    },
  };
}

test("resolveLocalExplanationRects uses anchor segments before fallback spanning boxes", () => {
  const question = buildQuestion("q1", 1);
  const answerPage: AnswerPagePayload = {
    id: "a1",
    pageNumber: 1,
    pageImageDataUrl: "data:image/png;base64,test",
    extractedTextSnippet: "1번 해설",
    answerAnchors: [
      {
        questionNumber: 1,
        bounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.85 },
        textSnippet: "1번 해설",
        segments: [
          { x: 0.08, y: 0.31, width: 0.25, height: 0.16 },
          { x: 0.38, y: 0.06, width: 0.27, height: 0.41 },
        ],
      },
      {
        questionNumber: 2,
        bounds: { x: 0.08, y: 0.5, width: 0.3, height: 0.2 },
        textSnippet: "2번 해설",
      },
    ],
  };

  const rects = resolveLocalExplanationRects(question, [question], answerPage, 1);

  assert.deepEqual(rects, [
    { x: 0.08, y: 0.31, width: 0.25, height: 0.16 },
    { x: 0.38, y: 0.06, width: 0.27, height: 0.41 },
  ]);
});
