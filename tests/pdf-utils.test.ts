import assert from "node:assert/strict";
import test from "node:test";
import { isLikelyQuestionRegion, isLikelyQuestionSnippet } from "@/lib/pdf-utils";

test("question snippet validator rejects short numeric debris", () => {
  assert.equal(isLikelyQuestionSnippet("1 12", 2), false);
  assert.equal(
    isLikelyQuestionRegion({
      questionNumber: 2,
      bounds: { x: 0.03, y: 0.31, width: 0.92, height: 0.09 },
      textSnippet: "1 12",
    }),
    false
  );
});

test("question snippet validator accepts real multiple-choice stems", () => {
  assert.equal(
    isLikelyQuestionSnippet("3. 이차방정식 x^2-3x-1=0의 두 근 중 양수인 근은? [2점] ① ② ③ ④ ⑤", 3),
    true
  );
  assert.equal(
    isLikelyQuestionRegion({
      questionNumber: 3,
      bounds: { x: 0.04, y: 0.18, width: 0.9, height: 0.22 },
      textSnippet: "3. 이차방정식 x^2-3x-1=0의 두 근 중 양수인 근은? [2점] ① ② ③ ④ ⑤",
    }),
    true
  );
});
