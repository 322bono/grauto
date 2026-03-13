"use client";

import { useMemo, useRef } from "react";
import { exportWrongAnswerPdf } from "@/lib/export-note";
import { clampBoundingBox, renderCropStyle } from "@/lib/pdf-utils";
import type { AnswerPagePayload, GradeResponsePayload, QuestionResult, SelectedQuestionRegionPayload } from "@/lib/types";

interface ResultsDashboardProps {
  result: GradeResponsePayload;
  questionSelections: SelectedQuestionRegionPayload[];
  answerPages: AnswerPagePayload[];
  examName: string;
  onManualOverride: (selectionId: string, isCorrect: boolean) => void;
}

export function ResultsDashboard({
  result,
  questionSelections,
  answerPages,
  examName,
  onManualOverride
}: ResultsDashboardProps) {
  const noteRef = useRef<HTMLDivElement | null>(null);

  const selectionMap = useMemo(
    () => new Map(questionSelections.map((selection) => [selection.id, selection])),
    [questionSelections]
  );
  const answerPageMap = useMemo(() => new Map(answerPages.map((page) => [page.pageNumber, page])), [answerPages]);
  const sortedQuestions = [...result.questions].sort(
    (a, b) => (a.questionNumber ?? Number.MAX_SAFE_INTEGER) - (b.questionNumber ?? Number.MAX_SAFE_INTEGER)
  );
  const wrongQuestions = sortedQuestions.filter((question) => !question.isCorrect);

  return (
    <div className="stack">
      <div className="card pad stack">
        <div className="selector-head">
          <div>
            <h2 className="section-title">채점 결과 리포트</h2>
            <p className="subtle">
              AI 자동 채점 후에도 각 문항에서 바로 정답/오답을 수동으로 수정할 수 있습니다. 현재 결과 모드:{" "}
              {result.mode === "vision" ? "Vision 분석" : "로컬 데모"}
            </p>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="cta secondary"
              onClick={async () => {
                if (noteRef.current) {
                  await exportWrongAnswerPdf(noteRef.current, `${examName || "시험"}-오답노트`);
                }
              }}
            >
              오답 노트 PDF 저장
            </button>
            <button type="button" className="cta ghost" onClick={() => window.print()}>
              오답 노트 인쇄
            </button>
          </div>
        </div>

        <div className="summary-grid">
          <div className="metric-card">
            <span className="subtle">총 문항 수</span>
            <strong>{result.summary.totalQuestions}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">정답 수</span>
            <strong>{result.summary.correctCount}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">오답 수</span>
            <strong>{result.summary.incorrectCount}</strong>
          </div>
          <div className="metric-card">
            <span className="subtle">정확도</span>
            <strong>{Math.round(result.summary.accuracyRate * 100)}%</strong>
          </div>
        </div>

        <div className="detail-row">
          <strong>취약 유형</strong>
          <div className="button-row" style={{ marginTop: 8 }}>
            {result.summary.weakAreas.length > 0 ? (
              result.summary.weakAreas.map((area) => (
                <span key={area} className="status warn">
                  {area}
                </span>
              ))
            ) : (
              <span className="status ok">취약 유형이 뚜렷하게 보이지 않습니다.</span>
            )}
          </div>
          <p className="subtle" style={{ marginBottom: 0 }}>
            {result.summary.encouragement}
          </p>
        </div>

        <div className="button-row">
          {sortedQuestions.map((question, index) => (
            <button
              key={question.selectionId}
              type="button"
              className="question-nav-button"
              style={{ padding: "10px 14px" }}
              onClick={() =>
                document.getElementById(`question-${question.selectionId}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {question.questionNumber ?? index + 1}번
            </button>
          ))}
        </div>
      </div>

      <div className="card-list stack">
        {sortedQuestions.map((question, index) => {
          const selection = selectionMap.get(question.selectionId);
          const answerPage = question.matchedAnswerPageNumber ? answerPageMap.get(question.matchedAnswerPageNumber) : undefined;

          return (
            <article className="card question-card" id={`question-${question.selectionId}`} key={question.selectionId}>
              <div className="question-head">
                <div>
                  <h3 style={{ margin: 0 }}>{question.questionNumber ?? index + 1}번 문항</h3>
                  <p className="subtle" style={{ marginBottom: 0 }}>
                    {question.detectedHeaderText || `문항 OCR 힌트가 없으면 ${selection?.pageNumber ?? "-"}페이지 기준으로 매칭했습니다.`}
                  </p>
                </div>
                <div className="button-row">
                  <span className={`status ${question.isCorrect ? "ok" : "danger"}`}>{question.isCorrect ? "정답" : "오답"}</span>
                  {question.reviewRequired ? <span className="status warn">검토 필요</span> : null}
                  {question.overrideApplied ? <span className="status ok">수동 수정됨</span> : null}
                </div>
              </div>

              <div className="question-body">
                <div className="stack">
                  <div className="detail-grid">
                    <div className="detail-row">
                      <strong>문제 보기</strong>
                      <div style={{ marginTop: 12 }}>
                        {selection ? <img alt="선택한 문제 영역" src={selection.snapshotDataUrl} /> : <div className="empty">문제 이미지가 없습니다.</div>}
                      </div>
                    </div>

                    <div className="detail-row">
                      <strong>해설 보기</strong>
                      <div style={{ marginTop: 12 }}>
                        {answerPage && question.explanationRegion ? (
                          <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rect={question.explanationRegion} />
                        ) : answerPage ? (
                          <img alt="매칭된 답안 페이지" src={answerPage.pageImageDataUrl} />
                        ) : (
                          <div className="empty">매칭된 답안 페이지가 없습니다.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="detail-grid">
                  <div className="detail-row">
                    <strong>자동 채점</strong>
                    <p style={{ marginBottom: 0 }}>
                      학생 답안: {question.studentAnswer || "미인식"} <br />
                      정답: {question.correctAnswer || "미인식"} <br />
                      유형: {questionTypeLabel(question.questionType)} <br />
                      신뢰도: {Math.round(question.confidence * 100)}%
                    </p>
                  </div>

                  <div className="detail-row">
                    <strong>풀이 흔적 분석</strong>
                    <p style={{ marginBottom: 0 }}>
                      판정: {authenticityLabel(question.workEvidence.authenticity)} <br />
                      근거: {question.workEvidence.rationale} <br />
                      인식된 표식: {question.workEvidence.detectedMarks.join(", ") || "없음"}
                    </p>
                  </div>

                  <div className="detail-row">
                    <strong>{question.isCorrect ? "해설 요약" : "오답 피드백"}</strong>
                    <p style={{ marginBottom: 0 }}>
                      {question.isCorrect ? "풀이 포인트" : "틀린 이유"}: {question.feedback.mistakeReason}
                      <br />
                      복습 포인트: {question.feedback.recommendedReview}
                      <br />
                      해설 요약: {question.feedback.explanation}
                    </p>
                  </div>

                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={() => onManualOverride(question.selectionId, true)}>
                      정답으로 수정
                    </button>
                    <button type="button" className="cta ghost" onClick={() => onManualOverride(question.selectionId, false)}>
                      오답으로 수정
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="card pad print-note-host">
        <div className="selector-head">
          <div>
            <h2 className="section-title">자동 오답 노트</h2>
            <p className="subtle">틀린 문제만 추려 문제 이미지와 해설을 다시 볼 수 있도록 구성했습니다.</p>
          </div>
        </div>

        <div className="note-sheet" ref={noteRef}>
          {wrongQuestions.length > 0 ? (
            wrongQuestions.map((question) => {
              const selection = selectionMap.get(question.selectionId);
              const answerPage = question.matchedAnswerPageNumber ? answerPageMap.get(question.matchedAnswerPageNumber) : undefined;

              return (
                <div className="note-card" key={`note-${question.selectionId}`} data-note-card="true">
                  <h3 style={{ marginTop: 0 }}>{question.questionNumber ?? "?"}번</h3>
                  <div className="question-body">
                    <div className="stack">
                      {selection ? <img alt="오답 문제 영역" src={selection.snapshotDataUrl} /> : null}
                      <div className="detail-row">
                        <strong>틀린 이유</strong>
                        <p style={{ marginBottom: 0 }}>{question.feedback.mistakeReason}</p>
                      </div>
                    </div>
                    <div className="stack">
                      {answerPage && question.explanationRegion ? (
                        <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rect={question.explanationRegion} />
                      ) : answerPage ? (
                        <img alt="정답 해설" src={answerPage.pageImageDataUrl} />
                      ) : null}
                      <div className="detail-row">
                        <strong>정답 해설</strong>
                        <p style={{ marginBottom: 0 }}>{question.feedback.explanation}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty">현재 오답이 없습니다. 지금 상태 그대로 PDF로 저장하면 전체 해설 리포트처럼 볼 수 있습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CroppedImage({
  imageDataUrl,
  rect
}: {
  imageDataUrl: string;
  rect: QuestionResult["explanationRegion"];
}) {
  const safeRect = clampBoundingBox(rect);

  if (!safeRect) {
    return <img alt="원본 페이지" src={imageDataUrl} />;
  }

  const styles = renderCropStyle(safeRect);

  return (
    <div className="crop-frame">
      <img alt="잘라낸 해설 영역" src={imageDataUrl} style={styles.img} />
    </div>
  );
}

function questionTypeLabel(type: QuestionResult["questionType"]) {
  switch (type) {
    case "multiple-choice":
      return "객관식";
    case "short-answer":
      return "단답형";
    case "essay":
      return "서술형";
    default:
      return type;
  }
}

function authenticityLabel(type: QuestionResult["workEvidence"]["authenticity"]) {
  switch (type) {
    case "solved":
      return "실제 풀이 흔적 있음";
    case "guessed":
      return "찍은 가능성 높음";
    case "blank":
      return "미응답";
    case "unclear":
      return "판단 보류";
    default:
      return type;
  }
}
