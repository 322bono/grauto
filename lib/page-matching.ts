import type { AnswerPagePayload, SelectedQuestionRegionPayload } from "@/lib/types";

interface RankedAnswerPage {
  page: AnswerPagePayload;
  score: number;
  reasons: string[];
}

const STOPWORDS = new Set([
  "problem",
  "answer",
  "explanation",
  "page",
  "the",
  "and",
]);

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTokens(text: string) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function extractPageReferences(text: string) {
  const refs = new Set<number>();
  const patterns = [/p\.?\s*(\d{1,4})/gi, /page\s*(\d{1,4})/gi];

  patterns.forEach((pattern) => {
    let match = pattern.exec(text);

    while (match) {
      refs.add(Number(match[1]));
      match = pattern.exec(text);
    }
  });

  return refs;
}

function intersectCount<T>(left: Iterable<T>, right: Iterable<T>) {
  const rightSet = new Set(right);
  let count = 0;

  for (const value of left) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }

  return count;
}

function listAnchorNumbers(page: AnswerPagePayload) {
  return (page.answerAnchors ?? [])
    .map((anchor) => anchor.questionNumber)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function pageContainsQuestionNumber(page: AnswerPagePayload, questionNumber: number | null | undefined) {
  if (!questionNumber) {
    return false;
  }

  return listAnchorNumbers(page).includes(questionNumber);
}

export function findBestAnswerPageByAnchors(
  answerPages: AnswerPagePayload[],
  questionNumber: number | null | undefined
) {
  if (!questionNumber) {
    return null;
  }

  return (
    answerPages.find((page) => pageContainsQuestionNumber(page, questionNumber)) ??
    null
  );
}

export function rankAnswerPageCandidates(
  selection: SelectedQuestionRegionPayload,
  answerPages: AnswerPagePayload[]
): RankedAnswerPage[] {
  const questionText = selection.extractedTextSnippet ?? "";
  const questionTokens = extractTokens(questionText);
  const questionRefs = extractPageReferences(questionText);
  const hintedQuestionNumber = selection.questionNumberHint ?? selection.displayOrder ?? null;

  return answerPages
    .map((page) => {
      const answerText = page.extractedTextSnippet ?? "";
      const answerTokens = extractTokens(answerText);
      const answerRefs = extractPageReferences(answerText);
      const tokenOverlap = intersectCount(questionTokens, answerTokens);
      const refOverlap = intersectCount(questionRefs, answerRefs);
      const anchorNumbers = listAnchorNumbers(page);
      const reasons: string[] = [];
      let score = 0;

      if (hintedQuestionNumber && anchorNumbers.includes(hintedQuestionNumber)) {
        score += 14;
        reasons.push(`anchor question ${hintedQuestionNumber} matched on page`);
      }

      if (refOverlap > 0) {
        score += 8;
        reasons.push(`page references overlapped ${refOverlap} time(s)`);
      }

      if (tokenOverlap > 0) {
        score += Math.min(6, tokenOverlap * 1.5);
        reasons.push(`text tokens overlapped ${tokenOverlap} time(s)`);
      }

      if (anchorNumbers.length === 0) {
        score -= 1;
        reasons.push("no local answer anchors found on this page");
      }

      if (!answerText) {
        score -= 0.6;
        reasons.push("page text hint was empty");
      }

      if (page.pageNumber === selection.pageNumber) {
        score += 0.25;
        reasons.push("same page number kept as a weak tie-breaker");
      }

      if (reasons.length === 0) {
        reasons.push("kept as a low-confidence fallback candidate");
      }

      return {
        page,
        score,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber);
}
