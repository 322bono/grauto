import type { GradeResponsePayload, GradeSummary, QuestionResult } from "@/lib/types";

function encouragementForAccuracy(rate: number) {
  if (rate >= 0.95) {
    return "전체적으로 매우 안정적입니다. 틀린 문제보다 풀이 과정을 다시 정리하는 복습이 더 큰 도움이 됩니다.";
  }

  if (rate >= 0.75) {
    return "기본 개념은 잘 잡혀 있습니다. 자주 틀린 유형만 다시 정리하면 점수를 더 끌어올릴 수 있습니다.";
  }

  if (rate >= 0.5) {
    return "개념과 풀이 순서를 함께 복습하는 것이 좋습니다. 틀린 이유를 확인하고 같은 유형을 다시 풀어보세요.";
  }

  return "핵심 개념부터 다시 다지는 편이 좋습니다. 오답 원인을 천천히 정리하면 다음 시험에서 훨씬 안정적으로 풀 수 있습니다.";
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
    .sort((left, right) => right[1] - left[1])
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

export function applyManualOverride(
  result: GradeResponsePayload,
  selectionId: string,
  isCorrect: boolean
): GradeResponsePayload {
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
