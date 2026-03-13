import type { NormalizedRect, QuestionResult } from "@/lib/types";

export function resolveLocalExplanationRect(
  question: QuestionResult,
  pageQuestions: QuestionResult[]
): NormalizedRect | null {
  const ordered = [...pageQuestions].sort(compareQuestionsOnPage);
  const currentIndex = ordered.findIndex((item) => item.selectionId === question.selectionId);

  if (currentIndex === -1) {
    return normalizeRect(question.explanationRegion);
  }

  const current = ordered[currentIndex];
  const next = ordered[currentIndex + 1];
  const guessedTop = getExplanationStart(current, currentIndex, ordered.length);
  const guessedNextStart = next ? getQuestionAnchor(next, currentIndex + 1, ordered.length) : 0.965;

  const top = clamp(guessedTop, 0.04, 0.9);

  let bottom = Math.min(
    current.explanationRegion ? current.explanationRegion.y + current.explanationRegion.height : 0.96,
    guessedNextStart - 0.018
  );

  if (!Number.isFinite(bottom) || bottom <= top + 0.1) {
    bottom = Math.min(0.965, top + Math.max(current.explanationRegion?.height ?? 0.22, 0.2));
  }

  const [x, width] = resolveHorizontalBounds(current);

  return normalizeRect({
    x,
    y: top,
    width,
    height: clamp(bottom - top, 0.12, 0.92 - top)
  });
}

function compareQuestionsOnPage(left: QuestionResult, right: QuestionResult) {
  const leftNumber = left.questionNumber ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = right.questionNumber ?? Number.MAX_SAFE_INTEGER;

  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return getVisualTop(left) - getVisualTop(right);
}

function getVisualTop(question: QuestionResult) {
  return question.answerRegion?.y ?? question.explanationRegion?.y ?? 1;
}

function getQuestionAnchor(question: QuestionResult, index: number, total: number) {
  if (question.answerRegion) {
    return question.answerRegion.y;
  }

  if (question.explanationRegion) {
    return question.explanationRegion.y;
  }

  return 0.08 + (index / Math.max(total, 1)) * 0.84;
}

function getExplanationStart(question: QuestionResult, index: number, total: number) {
  const answerBottom = question.answerRegion ? question.answerRegion.y + question.answerRegion.height + 0.012 : null;

  if (question.explanationRegion) {
    return Math.max(question.explanationRegion.y, answerBottom ?? 0);
  }

  if (answerBottom !== null) {
    return answerBottom;
  }

  return 0.14 + (index / Math.max(total, 1)) * 0.72;
}

function resolveHorizontalBounds(question: QuestionResult): [number, number] {
  if (!question.explanationRegion) {
    return [0.05, 0.9];
  }

  const left = clamp(Math.min(question.explanationRegion.x, 0.08), 0.03, 0.18);
  const right = clamp(Math.max(question.explanationRegion.x + question.explanationRegion.width, 0.9), 0.82, 0.97);

  return [left, clamp(right - left, 0.72, 0.92)];
}

function normalizeRect(rect: NormalizedRect | null): NormalizedRect | null {
  if (!rect) {
    return null;
  }

  return {
    x: clamp(rect.x, 0, 0.96),
    y: clamp(rect.y, 0, 0.96),
    width: clamp(rect.width, 0.04, 0.96),
    height: clamp(rect.height, 0.04, 0.96)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
