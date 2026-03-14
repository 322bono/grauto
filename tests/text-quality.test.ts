import assert from "node:assert/strict";
import test from "node:test";
import { stripNoticeText } from "@/lib/text-quality";

test("stripNoticeText removes copyright and redistribution notices", () => {
  const value =
    "1. 수학 영역 ※ 본 전국연합학력평가는 17개 시도 교육청 주관으로 시행되며, 해당 자료는 EBSi 에서만 제공됩니다. 무단 전재 및 재배포는 금지됩니다.";

  assert.equal(stripNoticeText(value), "");
});

test("stripNoticeText keeps actual explanation text while dropping notice sentences", () => {
  const value =
    "정답은 4번이다. 루트6과 루트 1/2를 먼저 곱하면 루트3이 된다. 무단 전재 및 재배포는 금지됩니다.";

  assert.equal(stripNoticeText(value), "정답은 4번이다. 루트6과 루트 1/2를 먼저 곱하면 루트3이 된다.");
});
