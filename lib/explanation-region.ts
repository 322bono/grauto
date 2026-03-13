import type { NormalizedRect, QuestionResult } from "@/lib/types";

interface PageColumn {
  id: "left" | "right" | "full";
  x: number;
  width: number;
}

export function resolveLocalExplanationRect(
  question: QuestionResult,
  pageQuestions: QuestionResult[]
): NormalizedRect | null {
  const normalizedExplanation = normalizeRect(question.explanationRegion);
  const layout = inferPageLayout(pageQuestions);
  const currentColumn = resolveQuestionColumn(question, layout);
  const currentTop = resolveExplanationTop(question);
  const nextQuestion = findNextQuestionInColumn(question, pageQuestions, currentColumn, layout);
  const nextAnchor = nextQuestion ? resolveQuestionTop(nextQuestion) - 0.02 : 0.965;

  let top = clamp(currentTop, 0.04, 0.92);
  let bottom = Math.min(nextAnchor, normalizedExplanation ? normalizedExplanation.y + normalizedExplanation.height : 0.965);

  if (!Number.isFinite(bottom) || bottom <= top + 0.08) {
    bottom = nextQuestion ? Math.max(top + 0.1, nextAnchor) : Math.min(0.965, top + Math.max(normalizedExplanation?.height ?? 0.22, 0.2));
  }

  const horizontal = resolveHorizontalBounds(question, currentColumn, layout);

  return normalizeRect({
    x: horizontal.x,
    y: top,
    width: horizontal.width,
    height: clamp(bottom - top, 0.08, 0.96 - top)
  });
}

function inferPageLayout(pageQuestions: QuestionResult[]) {
  const anchors = pageQuestions
    .map((item) => resolveBaseBox(item))
    .filter((box): box is NormalizedRect => Boolean(box))
    .map((box) => ({
      left: box.x,
      right: box.x + box.width,
      center: box.x + box.width / 2
    }));

  if (anchors.length < 2) {
    return {
      isTwoColumn: false,
      columns: [{ id: "full", x: 0.05, width: 0.9 } satisfies PageColumn]
    };
  }

  const leftCluster = anchors.filter((anchor) => anchor.center < 0.53);
  const rightCluster = anchors.filter((anchor) => anchor.center >= 0.53);
  const leftRightGap =
    leftCluster.length > 0 && rightCluster.length > 0
      ? Math.min(...rightCluster.map((item) => item.left)) - Math.max(...leftCluster.map((item) => item.right))
      : -1;
  const isTwoColumn = leftCluster.length > 0 && rightCluster.length > 0 && leftRightGap > 0.04;

  if (!isTwoColumn) {
    return {
      isTwoColumn: false,
      columns: [{ id: "full", x: 0.05, width: 0.9 } satisfies PageColumn]
    };
  }

  const leftStart = clamp(Math.min(...leftCluster.map((item) => item.left), 0.05), 0.03, 0.22);
  const leftEnd = clamp(Math.max(...leftCluster.map((item) => item.right), 0.47), 0.38, 0.58);
  const rightStart = clamp(Math.min(...rightCluster.map((item) => item.left), 0.52), 0.42, 0.72);
  const rightEnd = clamp(Math.max(...rightCluster.map((item) => item.right), 0.95), 0.78, 0.98);

  return {
    isTwoColumn: true,
    columns: [
      { id: "left", x: leftStart, width: clamp(leftEnd - leftStart, 0.26, 0.5) },
      { id: "right", x: rightStart, width: clamp(rightEnd - rightStart, 0.22, 0.5) }
    ] satisfies PageColumn[]
  };
}

function resolveQuestionColumn(
  question: QuestionResult,
  layout: ReturnType<typeof inferPageLayout>
) {
  if (!layout.isTwoColumn) {
    return layout.columns[0];
  }

  const box = resolveBaseBox(question);
  const center = box ? box.x + box.width / 2 : 0.5;

  return center < 0.53 ? layout.columns[0] : layout.columns[1];
}

function findNextQuestionInColumn(
  question: QuestionResult,
  pageQuestions: QuestionResult[],
  currentColumn: PageColumn,
  layout: ReturnType<typeof inferPageLayout>
) {
  const currentTop = resolveQuestionTop(question);

  return [...pageQuestions]
    .filter((candidate) => candidate.selectionId !== question.selectionId)
    .filter((candidate) => {
      const candidateColumn = resolveQuestionColumn(candidate, layout);
      return candidateColumn.id === currentColumn.id;
    })
    .filter((candidate) => resolveQuestionTop(candidate) > currentTop + 0.01)
    .sort((left, right) => resolveQuestionTop(left) - resolveQuestionTop(right))[0];
}

function resolveHorizontalBounds(
  question: QuestionResult,
  column: PageColumn,
  layout: ReturnType<typeof inferPageLayout>
) {
  const explanation = normalizeRect(question.explanationRegion);

  if (!layout.isTwoColumn) {
    if (!explanation) {
      return {
        x: column.x,
        width: column.width
      };
    }

    const left = clamp(Math.max(column.x, explanation.x - 0.01), column.x, column.x + 0.12);
    const right = clamp(explanation.x + explanation.width + 0.02, left + 0.3, 0.97);

    return {
      x: left,
      width: clamp(right - left, 0.38, 0.92)
    };
  }

  if (!explanation) {
    return {
      x: column.x,
      width: column.width
    };
  }

  const left = clamp(Math.max(column.x, explanation.x - 0.01), column.x, column.x + 0.06);
  const right = clamp(
    Math.min(column.x + column.width, explanation.x + explanation.width + 0.02),
    left + 0.18,
    column.x + column.width
  );

  return {
    x: left,
    width: clamp(right - left, 0.18, column.width)
  };
}

function resolveExplanationTop(question: QuestionResult) {
  const explanation = normalizeRect(question.explanationRegion);
  const answer = normalizeRect(question.answerRegion);
  const answerBottom = answer ? answer.y + answer.height + 0.012 : null;

  if (explanation) {
    return Math.max(explanation.y, answerBottom ?? 0);
  }

  if (answerBottom !== null) {
    return answerBottom;
  }

  return 0.14;
}

function resolveQuestionTop(question: QuestionResult) {
  const answer = normalizeRect(question.answerRegion);
  const explanation = normalizeRect(question.explanationRegion);

  if (answer) {
    return answer.y;
  }

  if (explanation) {
    return Math.max(0.04, explanation.y - 0.06);
  }

  return 0.9;
}

function resolveBaseBox(question: QuestionResult) {
  return normalizeRect(question.answerRegion) ?? normalizeRect(question.explanationRegion);
}

function normalizeRect(rect: NormalizedRect | null): NormalizedRect | null {
  if (!rect) {
    return null;
  }

  const x = clamp(rect.x, 0, 0.96);
  const y = clamp(rect.y, 0, 0.96);
  const width = clamp(rect.width, 0.04, 1 - x);
  const height = clamp(rect.height, 0.04, 1 - y);

  return { x, y, width, height };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
