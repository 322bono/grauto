"use client";

import { useMemo, useRef, useState } from "react";
import { exportWrongAnswerPdf } from "@/lib/export-note";
import { resolveLocalExplanationRect } from "@/lib/explanation-region";
import { clampBoundingBox, renderCropStyle } from "@/lib/pdf-utils";
import type { AnswerPagePayload, GradeResponsePayload, QuestionDeepAnalysis, QuestionResult, SelectedQuestionRegionPayload } from "@/lib/types";

interface ResultsDashboardProps {
  result: GradeResponsePayload;
  questionSelections: SelectedQuestionRegionPayload[];
  answerPages: AnswerPagePayload[];
  examName: string;
  onManualOverride: (selectionId: string, isCorrect: boolean) => void | Promise<void>;
  onRequestAnalysis?: (selectionId: string) => Promise<void>;
}

export function ResultsDashboard({
  result,
  questionSelections,
  answerPages,
  examName,
  onManualOverride,
  onRequestAnalysis
}: ResultsDashboardProps) {
  const noteRef = useRef<HTMLDivElement | null>(null);
  const [loadingAnalysisId, setLoadingAnalysisId] = useState<string | null>(null);

  const selectionMap = useMemo(
    () => new Map(questionSelections.map((selection) => [selection.id, selection])),
    [questionSelections]
  );
  const answerPageMap = useMemo(() => new Map(answerPages.map((page) => [page.pageNumber, page])), [answerPages]);
  const sortedQuestions = useMemo(
    () =>
      [...result.questions].sort(
        (left, right) => (left.questionNumber ?? Number.MAX_SAFE_INTEGER) - (right.questionNumber ?? Number.MAX_SAFE_INTEGER)
      ),
    [result.questions]
  );
  const pageQuestionMap = useMemo(() => {
    const nextMap = new Map<number, QuestionResult[]>();

    sortedQuestions.forEach((question) => {
      if (question.matchedAnswerPageNumber === null) {
        return;
      }

      const current = nextMap.get(question.matchedAnswerPageNumber) ?? [];
      current.push(question);
      nextMap.set(question.matchedAnswerPageNumber, current);
    });

    return nextMap;
  }, [sortedQuestions]);
  const wrongQuestions = sortedQuestions.filter((question) => !question.isCorrect);

  async function handleAnalysisClick(selectionId: string) {
    if (!onRequestAnalysis) {
      return;
    }

    setLoadingAnalysisId(selectionId);

    try {
      await onRequestAnalysis(selectionId);
    } finally {
      setLoadingAnalysisId((current) => (current === selectionId ? null : current));
    }
  }

  return (
    <div className="stack">
      <div className="card pad stack">
        <div className="selector-head">
          <div>
            <h2 className="section-title">채점 결과 리포트</h2>
            <p className="subtle">
              기본 채점은 빠르게 처리하고, 오답 분석은 필요한 문항에서만 버튼으로 따로 요청하도록 구성했습니다.
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
            <span className="subtle">총 문제 수</span>
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
              <span className="status ok">아직 뚜렷한 취약 유형은 보이지 않습니다.</span>
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
          const pageQuestions = question.matchedAnswerPageNumber ? pageQuestionMap.get(question.matchedAnswerPageNumber) ?? [question] : [question];
          const explanationRect = resolveLocalExplanationRect(question, pageQuestions);
          const isAnalyzing = loadingAnalysisId === question.selectionId;
          const analysis = normalizeAnalysis(question.deepAnalysis);

          return (
            <article className="card question-card" id={`question-${question.selectionId}`} key={question.selectionId}>
              <div className="question-head">
                <div>
                  <h3 style={{ margin: 0 }}>{question.questionNumber ?? index + 1}번 문항</h3>
                  <p className="subtle" style={{ marginBottom: 0 }}>
                    {question.detectedHeaderText || `페이지 ${selection?.pageNumber ?? "-"} 기준으로 매칭했습니다.`}
                  </p>
                </div>
                <div className="button-row">
                  <span className={`status ${question.isCorrect ? "ok" : "danger"}`}>{question.isCorrect ? "정답" : "오답"}</span>
                  {question.reviewRequired ? <span className="status warn">재검토 필요</span> : null}
                  {question.overrideApplied ? <span className="status ok">수동 수정됨</span> : null}
                </div>
              </div>

              <div className="question-body">
                <div className="stack">
                  <div className="detail-grid">
                    <div className="detail-row">
                      <strong>문제</strong>
                      <div style={{ marginTop: 12 }}>
                        {selection ? <img alt="선택한 문제 영역" src={selection.snapshotDataUrl} /> : <div className="empty">문제 이미지가 없습니다.</div>}
                      </div>
                    </div>

                    <div className="detail-row">
                      <strong>해설</strong>
                      <div style={{ marginTop: 12 }}>
                        {answerPage && explanationRect ? (
                          <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rect={explanationRect} />
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
                    <strong>기본 채점</strong>
                    <p style={{ marginBottom: 0 }}>
                      학생 답안: {question.studentAnswer || "미인식"} <br />
                      정답: {question.correctAnswer || "미인식"} <br />
                      유형: {questionTypeLabel(question.questionType)} <br />
                      정답 여부: {String(question.isCorrect)} <br />
                      신뢰도: {Math.round(question.confidence * 100)}%
                    </p>
                  </div>

                  <div className="detail-row">
                    <strong>풀이 흔적</strong>
                    <p style={{ marginBottom: 0 }}>
                      판정: {authenticityLabel(question.workEvidence.authenticity)} <br />
                      근거: {question.workEvidence.rationale} <br />
                      인식된 흔적: {question.workEvidence.detectedMarks.join(", ") || "없음"}
                    </p>
                  </div>

                  <div className="detail-row">
                    <strong>{question.isCorrect ? "짧은 해설 메모" : "오답 메모"}</strong>
                    <p style={{ marginBottom: 0 }}>
                      판단 메모: {question.feedback.mistakeReason}
                      <br />
                      해설 요약: {question.feedback.explanation}
                      <br />
                      복습 포인트: {question.feedback.recommendedReview}
                    </p>
                  </div>

                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={() => void onManualOverride(question.selectionId, true)}>
                      정답으로 수정
                    </button>
                    <button type="button" className="cta ghost" onClick={() => void onManualOverride(question.selectionId, false)}>
                      오답으로 수정
                    </button>
                    {!question.isCorrect ? (
                      <button
                        type="button"
                        className="cta ghost"
                        disabled={!onRequestAnalysis || isAnalyzing}
                        onClick={() => void handleAnalysisClick(question.selectionId)}
                      >
                        {isAnalyzing ? "분석 중..." : analysis ? "분석 다시 요청" : "오답 분석 요청"}
                      </button>
                    ) : null}
                  </div>

                  {analysis ? (
                    <div className="analysis-card">
                      <div className="analysis-card-head">
                        <strong>오답 분석</strong>
                        <span className="status warn">버튼 호출</span>
                      </div>
                      <div className="detail-row">
                        <strong>단계별 이유</strong>
                        <ol className="analysis-list">
                          {analysis.reasonSteps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      </div>
                      <div className="detail-row">
                        <strong>답지 해설 기준</strong>
                        <p style={{ marginBottom: 0 }}>{analysis.answerSheetBasis}</p>
                      </div>
                      <div className="detail-row">
                        <strong>한 줄 요약</strong>
                        <p style={{ marginBottom: 0 }}>{analysis.oneLineSummary}</p>
                      </div>
                    </div>
                  ) : null}
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
            <p className="subtle">틀린 문제만 따로 모아 문제 이미지와 해설을 다시 볼 수 있게 정리했습니다.</p>
          </div>
        </div>

        <div className="note-sheet" ref={noteRef}>
          {wrongQuestions.length > 0 ? (
            wrongQuestions.map((question) => {
              const selection = selectionMap.get(question.selectionId);
              const answerPage = question.matchedAnswerPageNumber ? answerPageMap.get(question.matchedAnswerPageNumber) : undefined;
              const pageQuestions = question.matchedAnswerPageNumber ? pageQuestionMap.get(question.matchedAnswerPageNumber) ?? [question] : [question];
              const explanationRect = resolveLocalExplanationRect(question, pageQuestions);
              const analysis = normalizeAnalysis(question.deepAnalysis);

              return (
                <div className="note-card" key={`note-${question.selectionId}`} data-note-card="true">
                  <h3 style={{ marginTop: 0 }}>{question.questionNumber ?? "?"}번</h3>
                  <div className="question-body">
                    <div className="stack">
                      {selection ? <img alt="오답 문제 영역" src={selection.snapshotDataUrl} /> : null}
                      <div className="detail-row">
                        <strong>틀린 이유</strong>
                        <p style={{ marginBottom: 0 }}>{analysis?.oneLineSummary || question.feedback.mistakeReason}</p>
                      </div>
                    </div>
                    <div className="stack">
                      {answerPage && explanationRect ? (
                        <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rect={explanationRect} />
                      ) : answerPage ? (
                        <img alt="정답 해설" src={answerPage.pageImageDataUrl} />
                      ) : null}
                      <div className="detail-row">
                        <strong>답지 해설</strong>
                        <p style={{ marginBottom: 0 }}>{question.feedback.explanation}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty">현재 오답이 없습니다. 이 상태 그대로 PDF로 저장하면 전체 해설 리포트처럼 활용할 수 있습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function normalizeAnalysis(analysis?: QuestionDeepAnalysis | null) {
  if (!analysis) {
    return null;
  }

  const reasonSteps =
    analysis.reasonSteps && analysis.reasonSteps.length > 0
      ? analysis.reasonSteps
      : [analysis.logicalGap, analysis.conceptGap, analysis.modelSolution].filter(
          (value): value is string => Boolean(value && value.trim())
        );

  const oneLineSummary = analysis.oneLineSummary || analysis.studyTip;

  if (reasonSteps.length === 0 && !oneLineSummary) {
    return null;
  }

  return {
    reasonSteps: reasonSteps.length > 0 ? reasonSteps : ["추가 분석 결과가 비어 있습니다."],
    answerSheetBasis: analysis.answerSheetBasis || "답지 해설 기준 문장을 아직 정리하지 못했습니다.",
    oneLineSummary: oneLineSummary || "개념 연결과 풀이 순서를 다시 점검해 보세요."
  };
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
      return "직접 풀이 흔적이 있습니다";
    case "guessed":
      return "찍은 가능성이 높습니다";
    case "blank":
      return "거의 비어 있습니다";
    case "unclear":
      return "판단이 애매합니다";
    default:
      return type;
  }
}
