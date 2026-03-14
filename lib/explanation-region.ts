import type { NormalizedRect, QuestionResult } from "@/lib/types";

interface PageColumn {
  id: string;
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
  const suggestedBottom = normalizedExplanation ? normalizedExplanation.y + normalizedExplanation.height : 0.965;

  let top = clamp(currentTop, 0.04, 0.92);
  let bottom = Math.min(nextAnchor, suggestedBottom);

  if (!nextQuestion && normalizedExplanation && normalizedExplanation.height > 0.56) {
    bottom = Math.min(bottom, top + 0.36);
  }

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
      columns: [{ id: "full", x: 0.05, width: 0.9 } satisfies PageColumn]
    };
  }

  const groups = buildColumnGroups(anchors);

  if (groups.length <= 1) {
    return {
      columns: [{ id: "full", x: 0.05, width: 0.9 } satisfies PageColumn]
    };
  }

  return {
    columns: groups.map((group, index) => {
      const left = clamp(Math.min(...group.map((item) => item.left)) - 0.01, 0.03, 0.92);
      const right = clamp(Math.max(...group.map((item) => item.right)) + 0.02, left + 0.14, 0.98);

      return {
        id: `col-${index + 1}`,
        x: left,
        width: clamp(right - left, 0.16, 0.92)
      } satisfies PageColumn;
    })
  };
}

function resolveQuestionColumn(
  question: QuestionResult,
  layout: ReturnType<typeof inferPageLayout>
) {
  if (layout.columns.length <= 1) {
    return layout.columns[0];
  }

  const box = resolveBaseBox(question);
  const center = box ? box.x + box.width / 2 : 0.5;

  return [...layout.columns].sort(
    (left, right) => Math.abs(center - (left.x + left.width / 2)) - Math.abs(center - (right.x + right.width / 2))
  )[0];
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

  if (layout.columns.length <= 1) {
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

function buildColumnGroups(anchors: Array<{ left: number; right: number; center: number }>) {
  const sorted = [...anchors].sort((left, right) => left.center - right.center);
  const groups: Array<Array<{ left: number; right: number; center: number }>> = [];

  sorted.forEach((anchor) => {
    const previous = groups[groups.length - 1];

    if (!previous) {
      groups.push([anchor]);
      return;
    }

    const previousCenter = average(previous.map((item) => item.center));
    const previousRight = Math.max(...previous.map((item) => item.right));
    const centerGap = anchor.center - previousCenter;
    const leftGap = anchor.left - previousRight;

    if (centerGap <= 0.14 || leftGap <= 0.035) {
      previous.push(anchor);
      return;
    }

    groups.push([anchor]);
  });

  return groups.slice(0, 3);
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
