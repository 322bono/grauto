import type { GradeResponsePayload, GradeSummary, QuestionResult } from "@/lib/types";

function encouragementForAccuracy(rate: number) {
  if (rate >= 0.95) {
    return "현재 거의 완벽합니다. 오답보다 풀이 전략을 유지하는 복습이 더 중요합니다.";
  }

  if (rate >= 0.75) {
    return "전반적인 기초는 탄탄합니다. 틀린 유형만 다시 묶어 복습하면 빠르게 점수가 올라갑니다.";
  }

  if (rate >= 0.5) {
    return "핵심 개념과 풀이 루틴을 다시 정리하면 확실히 개선 여지가 큽니다.";
  }

  return "개념 복습과 대표 문제 재풀이를 먼저 권장합니다. 지금은 정확한 오답 분석이 가장 큰 지름길입니다.";
}

export function buildSummary(questions: QuestionResult[]): GradeSummary {
  const totalQuestions = questions.length;
  const correctCount = questions.filter((item) => item.isCorrect).length;
  const reviewRequiredCount = questions.filter((item) => item.reviewRequired).length;
  const incorrectCount = totalQuestions - correctCount;
  const accuracyRate = totalQuestions === 0 ? 0 : correctCount / totalQuestions;
  const tagCounts = new Map<string, number>();

  questions
    .filter((item) => !item.isCorrect)
    .flatMap((item) => item.feedback.conceptTags)
    .forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    });

  const weakAreas = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    totalQuestions,
    correctCount,
    incorrectCount,
    reviewRequiredCount,
    accuracyRate,
    weakAreas,
    encouragement: encouragementForAccuracy(accuracyRate)
  };
}

export function applyManualOverride(result: GradeResponsePayload, selectionId: string, isCorrect: boolean): GradeResponsePayload {
  const questions = result.questions.map((question) => {
    if (question.selectionId !== selectionId) {
      return question;
    }

    return {
      ...question,
      isCorrect,
      overrideApplied: true,
      reviewRequired: false,
      score: isCorrect ? question.maxScore : 0
    };
  });

  return {
    ...result,
    summary: buildSummary(questions),
    questions
  };
}
