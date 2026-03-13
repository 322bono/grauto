import type { AnswerPagePayload, SelectedQuestionRegionPayload } from "@/lib/types";

interface RankedAnswerPage {
  page: AnswerPagePayload;
  score: number;
  reasons: string[];
}

const STOPWORDS = new Set([
  "문제",
  "해설",
  "정답",
  "정리",
  "답지",
  "단원",
  "테스트",
  "모의고사",
  "the",
  "and"
]);

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function extractTokens(text: string) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function extractPageReferences(text: string) {
  const refs = new Set<number>();
  const patterns = [
    /p\.?\s*(\d{1,4})/gi,
    /(\d{1,4})\s*쪽/gi,
    /page\s*(\d{1,4})/gi
  ];

  patterns.forEach((pattern) => {
    let match: RegExpExecArray | null;
    match = pattern.exec(text);
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

export function rankAnswerPageCandidates(selection: SelectedQuestionRegionPayload, answerPages: AnswerPagePayload[]): RankedAnswerPage[] {
  const questionText = selection.extractedTextSnippet ?? "";
  const questionTokens = extractTokens(questionText);
  const questionRefs = extractPageReferences(questionText);

  return answerPages
    .map((page) => {
      const answerText = page.extractedTextSnippet ?? "";
      const answerTokens = extractTokens(answerText);
      const answerRefs = extractPageReferences(answerText);
      const tokenOverlap = intersectCount(questionTokens, answerTokens);
      const refOverlap = intersectCount(questionRefs, answerRefs);
      const reasons: string[] = [];
      let score = 0;

      if (refOverlap > 0) {
        score += 9;
        reasons.push("질문 페이지 단서와 답안 페이지의 쪽수 참조가 일치");
      }

      if (tokenOverlap > 0) {
        score += Math.min(6, tokenOverlap * 1.5);
        reasons.push(`상단 제목/텍스트 토큰 ${tokenOverlap}개 겹침`);
      }

      if (!answerText) {
        score -= 0.6;
        reasons.push("임베디드 텍스트가 없어 Vision OCR 의존");
      }

      if (page.pageNumber === selection.pageNumber) {
        score += 0.25;
        reasons.push("통합 PDF일 가능성을 고려해 동일 페이지 번호에 소량 가점");
      }

      if (reasons.length === 0) {
        reasons.push("명시 단서가 적어 보수적으로 후보 유지");
      }

      return {
        page,
        score,
        reasons
      };
    })
    .sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber);
}
