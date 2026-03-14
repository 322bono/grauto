"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { exportWrongAnswerPdf, printWrongAnswerNote } from "@/lib/export-note";
import { resolveLocalExplanationRects } from "@/lib/explanation-region";
import { cropImageDataUrlSegments } from "@/lib/image-crop";
import { clampBoundingBox, renderCropStyle } from "@/lib/pdf-utils";
import { stripNoticeText } from "@/lib/text-quality";
import type {
  AnswerPagePayload,
  GradeResponsePayload,
  NormalizedRect,
  QuestionDeepAnalysis,
  QuestionProcessStep,
  QuestionResult,
  SelectedQuestionRegionPayload,
} from "@/lib/types";

interface ResultsDashboardProps {
  result: GradeResponsePayload;
  questionSelections: SelectedQuestionRegionPayload[];
  answerPages: AnswerPagePayload[];
  examName: string;
  onManualOverride: (selectionId: string, isCorrect: boolean) => void | Promise<void>;
  onRequestAnalysis?: (selectionId: string) => Promise<void>;
}

interface ViewerState {
  src: string;
  alt: string;
  title: string;
}

interface WrongNoteEntry {
  question: QuestionResult;
  selection?: SelectedQuestionRegionPayload;
  answerPage?: AnswerPagePayload;
  analysis: ReturnType<typeof normalizeAnalysis>;
  displayQuestionNumber: number;
  explanationRects: NormalizedRect[];
}

export function ResultsDashboard({
  result,
  questionSelections,
  answerPages,
  examName,
  onManualOverride,
  onRequestAnalysis,
}: ResultsDashboardProps) {
  const printNoteRef = useRef<HTMLDivElement | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [loadingAnalysisId, setLoadingAnalysisId] = useState<string | null>(null);

  const selectionMap = useMemo(
    () => new Map(questionSelections.map((selection) => [selection.id, selection])),
    [questionSelections]
  );
  const answerPageMap = useMemo(() => new Map(answerPages.map((page) => [page.pageNumber, page])), [answerPages]);
  const getActualQuestionNumber = (question: QuestionResult, selection?: SelectedQuestionRegionPayload | null) =>
    selection?.questionNumberHint ?? question.questionNumber ?? selection?.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const sortedQuestions = useMemo(
    () =>
      [...result.questions].sort((left, right) => {
        const leftSelection = selectionMap.get(left.selectionId);
        const rightSelection = selectionMap.get(right.selectionId);
        const leftOrder = getActualQuestionNumber(left, leftSelection);
        const rightOrder = getActualQuestionNumber(right, rightSelection);

        return leftOrder - rightOrder;
      }),
    [result.questions, selectionMap]
  );
  const resolvedPageNumberMap = useMemo(() => {
    const nextMap = new Map<string, number | null>();

    sortedQuestions.forEach((question, index) => {
      const selection = selectionMap.get(question.selectionId);
      const displayQuestionNumber = getActualQuestionNumber(question, selection) || index + 1;
      const targetQuestionNumber = selection?.questionNumberHint ?? question.questionNumber ?? displayQuestionNumber;
      const matchedPage = question.matchedAnswerPageNumber
        ? answerPageMap.get(question.matchedAnswerPageNumber)
        : undefined;
      const matchedPageHasTarget =
        matchedPage && targetQuestionNumber
          ? (matchedPage.answerAnchors ?? []).some((anchor) => anchor.questionNumber === targetQuestionNumber)
          : false;
      const anchoredPage =
        targetQuestionNumber
          ? answerPages.find((page) =>
              (page.answerAnchors ?? []).some((anchor) => anchor.questionNumber === targetQuestionNumber)
            )
          : undefined;

      nextMap.set(
        question.selectionId,
        matchedPageHasTarget
          ? matchedPage?.pageNumber ?? null
          : anchoredPage?.pageNumber ?? question.matchedAnswerPageNumber ?? null
      );
    });

    return nextMap;
  }, [answerPageMap, answerPages, selectionMap, sortedQuestions]);
  const pageQuestionMap = useMemo(() => {
    const nextMap = new Map<number, QuestionResult[]>();

    sortedQuestions.forEach((question) => {
      const resolvedPageNumber = resolvedPageNumberMap.get(question.selectionId);

      if (resolvedPageNumber === null || resolvedPageNumber === undefined) {
        return;
      }

      const current = nextMap.get(resolvedPageNumber) ?? [];
      current.push(question);
      nextMap.set(resolvedPageNumber, current);
    });

    return nextMap;
  }, [resolvedPageNumberMap, sortedQuestions]);
  const wrongQuestions = sortedQuestions.filter((question) => !question.isCorrect);
  const wrongNoteEntries = useMemo<WrongNoteEntry[]>(
    () =>
      wrongQuestions.map((question, index) => {
        const selection = selectionMap.get(question.selectionId);
        const answerPage = getResolvedAnswerPage(question);
        const resolvedPageNumber = resolvedPageNumberMap.get(question.selectionId);
        const pageQuestions = resolvedPageNumber ? pageQuestionMap.get(resolvedPageNumber) ?? [question] : [question];
        const analysis = normalizeAnalysis(question.deepAnalysis);
        const displayQuestionNumber = getDisplayQuestionNumber(question, index);
        const explanationTargetNumber = selection?.questionNumberHint ?? question.questionNumber ?? displayQuestionNumber;
        const explanationRects = resolveLocalExplanationRects(question, pageQuestions, answerPage, explanationTargetNumber);

        return {
          question,
          selection,
          answerPage,
          analysis,
          displayQuestionNumber,
          explanationRects,
        };
      }),
    [pageQuestionMap, resolvedPageNumberMap, selectionMap, sortedQuestions, wrongQuestions]
  );

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

  function getDisplayQuestionNumber(question: QuestionResult, fallbackIndex: number) {
    const selection = selectionMap.get(question.selectionId);
    return getActualQuestionNumber(question, selection) || fallbackIndex + 1;
  }

  function getResolvedAnswerPage(question: QuestionResult) {
    const resolvedPageNumber = resolvedPageNumberMap.get(question.selectionId);
    return resolvedPageNumber ? answerPageMap.get(resolvedPageNumber) : undefined;
  }

  return (
    <div className="results-shell stack">
      <section className="results-report-card">
        <div className="results-report-head">
          <div>
            <span className="results-report-kicker">Grauto</span>
            <h2 className="results-report-title">채점 리포트</h2>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="cta secondary"
              onClick={async () => {
                if (printNoteRef.current) {
                  await exportWrongAnswerPdf(printNoteRef.current, `${examName || "시험"}-오답노트`);
                }
              }}
            >
              오답 노트 PDF
            </button>
            <button
              type="button"
              className="cta ghost"
              onClick={async () => {
                if (printNoteRef.current) {
                  await printWrongAnswerNote(printNoteRef.current, `${examName || "시험"} 오답노트`);
                }
              }}
            >
              인쇄
            </button>
          </div>
        </div>

        <div className="results-report-body">
          <ReportRing
            total={result.summary.totalQuestions}
            correct={result.summary.correctCount}
            incorrect={result.summary.incorrectCount}
            reviewRequired={result.summary.reviewRequiredCount}
          />

          <div className="results-report-stats">
            <MetricLine label="오답" value={`${result.summary.incorrectCount}개`} tone="danger" />
            <MetricLine label="정답" value={`${result.summary.correctCount}개`} tone="info" />
            <MetricLine label="재확인" value={`${result.summary.reviewRequiredCount}개`} tone="success" />
          </div>

          <div className="results-report-copy">
            <p className="results-report-accuracy">정답률 {(result.summary.accuracyRate * 100).toFixed(1)}%</p>
            <p className="results-report-quote">{buildReportQuote(result.summary.accuracyRate)}</p>
            <p className="results-report-note">
              {sanitizeText(result.summary.encouragement, "결과를 바탕으로 다음 복습 포인트를 정리해 보세요.")}
            </p>
            {result.summary.weakAreas.length > 0 ? (
              <div className="results-weak-list">
                {result.summary.weakAreas.map((area) => (
                  <span key={area} className="results-weak-pill">
                    {area}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="results-question-nav">
          {sortedQuestions.map((question, index) => (
            <button
              key={question.selectionId}
              type="button"
              className="results-question-jump"
              onClick={() =>
                document.getElementById(`question-${question.selectionId}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {getDisplayQuestionNumber(question, index)}번
            </button>
          ))}
        </div>
      </section>

      <div className="results-question-list stack">
        {sortedQuestions.map((question, index) => {
          const selection = selectionMap.get(question.selectionId);
          const answerPage = getResolvedAnswerPage(question);
          const resolvedPageNumber = resolvedPageNumberMap.get(question.selectionId);
          const pageQuestions = resolvedPageNumber ? pageQuestionMap.get(resolvedPageNumber) ?? [question] : [question];
          const displayQuestionNumber = getDisplayQuestionNumber(question, index);
          const explanationTargetNumber = selection?.questionNumberHint ?? question.questionNumber ?? displayQuestionNumber;
          const explanationRects = resolveLocalExplanationRects(question, pageQuestions, answerPage, explanationTargetNumber);
          const analysis = normalizeAnalysis(question.deepAnalysis);
          const isAnalyzing = loadingAnalysisId === question.selectionId;

          return (
            <article className="result-question-card" id={`question-${question.selectionId}`} key={question.selectionId}>
              <div className="result-card-head">
                <div>
                  <h3 className="result-card-title">{displayQuestionNumber}번 문제</h3>
                </div>
                <div className="button-row">
                  <StatusBadge type={question.isCorrect ? "correct" : "wrong"} />
                  {question.reviewRequired ? <span className="results-mini-pill warning">재확인 필요</span> : null}
                </div>
              </div>

              <button
                type="button"
                className="result-question-stage"
                onClick={() =>
                  selection
                    ? setViewer({
                        src: selection.snapshotDataUrl,
                        alt: `${displayQuestionNumber}번 문제`,
                        title: `${displayQuestionNumber}번 문제`,
                      })
                    : null
                }
              >
                {selection ? (
                  <img alt={`${displayQuestionNumber}번 문제`} src={selection.snapshotDataUrl} />
                ) : (
                  <div className="empty">문제 이미지를 찾지 못했습니다.</div>
                )}
                <span className="result-zoom-hint">눌러서 확대</span>
              </button>

              <div className="result-lower-grid">
                <section className="result-info-panel">
                  <div className="result-panel-head">
                    <strong>채점 정보</strong>
                    <div className="result-override-actions">
                      <button type="button" className="results-mini-button" onClick={() => void onManualOverride(question.selectionId, true)}>
                        정답 처리
                      </button>
                      <button type="button" className="results-mini-button" onClick={() => void onManualOverride(question.selectionId, false)}>
                        오답 처리
                      </button>
                    </div>
                  </div>

                  <ResultFactRow label="학생의 답" value={displayAnswer(question.studentAnswer)} tone={question.isCorrect ? "success" : "danger"} />
                  <ResultFactRow label="정답" value={displayAnswer(question.correctAnswer)} tone="success" />
                  <ResultFactRow label="유형" value={questionTypeLabel(question.questionType)} tone="neutral" />
                  <ResultFactRow label="판정" value={question.isCorrect ? "정답" : "오답"} tone={question.isCorrect ? "success" : "danger"} />
                  <ResultFactRow label="신뢰도" value={confidenceLabel(question.confidence)} tone={confidenceTone(question.confidence)} />

                  {renderWorkSummary(question) ? <p className="result-work-summary">{renderWorkSummary(question)}</p> : null}

                  {!question.isCorrect && onRequestAnalysis ? (
                    <button
                      type="button"
                      className="results-analysis-button"
                      disabled={isAnalyzing}
                      onClick={() => void handleAnalysisClick(question.selectionId)}
                    >
                      {isAnalyzing ? "분석 중..." : analysis ? "오답 분석 다시 요청" : "오답 분석 요청"}
                    </button>
                  ) : null}

                  {analysis ? (
                    <div className="result-analysis-summary">
                      <strong>핵심 요약</strong>
                      <p>{sanitizeText(analysis.oneLineSummary, sanitizeText(question.feedback.mistakeReason, "핵심 조건과 풀이 순서를 다시 확인해 보세요."))}</p>
                    </div>
                  ) : null}
                </section>

                <section className="result-explanation-panel">
                  <div className="result-panel-head">
                    <strong>문항 해설</strong>
                  </div>

                  {answerPage && explanationRects.length > 0 ? (
                    <button
                      type="button"
                      className="result-explanation-preview"
                      onClick={async () => {
                        const croppedSrc = await cropImageDataUrlSegments(answerPage.pageImageDataUrl, explanationRects);

                        setViewer({
                          src: croppedSrc ?? answerPage.pageImageDataUrl,
                          alt: `${displayQuestionNumber}번 해설`,
                          title: `${displayQuestionNumber}번 해설`,
                        });
                      }}
                    >
                      <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rects={explanationRects} />
                      <span className="result-zoom-hint">눌러서 확대</span>
                    </button>
                  ) : (
                    <div className="empty">해설 이미지를 찾지 못했습니다.</div>
                  )}

                  <div className="result-explanation-copy">
                    <p>
                      {question.isCorrect
                        ? sanitizeText(question.feedback.explanation, "해설 이미지를 눌러 자세히 확인해 보세요.")
                        : sanitizeText(
                            analysis?.answerSheetBasis || question.feedback.explanation,
                            "답지 해설의 조건과 계산 순서를 다시 비교해 보세요."
                          )}
                    </p>

                    {!question.isCorrect && analysis?.processSteps?.length ? (
                      <div className="result-step-list">
                        {analysis.processSteps.map((step) => (
                          <StepCard key={`${question.selectionId}-${step.order}`} step={step} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            </article>
          );
        })}
      </div>

      <section className="card pad results-note-host">
        <div className="selector-head">
          <div>
            <h2 className="section-title">오답 노트</h2>
          </div>
        </div>

        <div className="note-sheet results-note-sheet">
          {wrongNoteEntries.length > 0 ? (
            wrongNoteEntries.map((entry) => (
              <div className="note-card results-note-card" key={`screen-note-${entry.question.selectionId}`}>
                <div className="results-note-card-head">
                  <h3>{entry.displayQuestionNumber}번</h3>
                  <span className="results-mini-pill warning">오답</span>
                </div>
                <div className="results-note-grid">
                  <div className="stack">
                    {entry.selection ? <img alt={`${entry.displayQuestionNumber}번 문제`} src={entry.selection.snapshotDataUrl} /> : null}
                    <p className="result-note-copy">
                      {sanitizeText(
                        entry.analysis?.oneLineSummary || entry.question.feedback.mistakeReason,
                        "오답 이유를 다시 확인해 보세요."
                      )}
                    </p>
                  </div>
                  <div className="stack">
                    {entry.answerPage && entry.explanationRects.length > 0 ? (
                      <CroppedImage imageDataUrl={entry.answerPage.pageImageDataUrl} rects={entry.explanationRects} />
                    ) : entry.answerPage ? (
                      <img alt={`${entry.displayQuestionNumber}번 해설`} src={entry.answerPage.pageImageDataUrl} />
                    ) : null}
                    <p className="result-note-copy">
                      {sanitizeText(
                        entry.analysis?.answerSheetBasis || entry.question.feedback.explanation,
                        "답지 해설을 다시 읽고 풀이 순서를 정리해 보세요."
                      )}
                    </p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">오답이 없어 오답 노트가 비어 있습니다.</div>
          )}
        </div>
      </section>

      <div className="print-note-render-root" ref={printNoteRef} aria-hidden="true">
        {wrongNoteEntries.map((entry) => (
          <PrintNoteCard entry={entry} key={`print-note-${entry.question.selectionId}`} />
        ))}
      </div>

      {viewer ? (
        <div className="image-viewer-backdrop" onClick={() => setViewer(null)}>
          <div className="image-viewer-card" onClick={(event) => event.stopPropagation()}>
            <div className="image-viewer-head">
              <strong>{viewer.title}</strong>
              <button type="button" className="results-mini-button" onClick={() => setViewer(null)}>
                닫기
              </button>
            </div>
            <img alt={viewer.alt} src={viewer.src} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReportRing({
  total,
  correct,
  incorrect,
  reviewRequired,
}: {
  total: number;
  correct: number;
  incorrect: number;
  reviewRequired: number;
}) {
  const segments = total
    ? [
        { color: "#ff6b6b", value: incorrect / total },
        { color: "#3b82f6", value: correct / total },
        { color: "#8fd14f", value: reviewRequired / total },
      ].filter((segment) => segment.value > 0)
    : [];

  let offset = 0;

  return (
    <div className="results-ring-shell">
      <svg className="results-ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="46" className="results-ring-track" pathLength="100" />
        {segments.map((segment) => {
          const currentOffset = offset;
          offset += segment.value * 100;

          return (
            <circle
              key={`${segment.color}-${currentOffset}`}
              cx="60"
              cy="60"
              r="46"
              pathLength="100"
              className="results-ring-segment"
              style={{
                stroke: segment.color,
                strokeDasharray: `${segment.value * 100} 100`,
                strokeDashoffset: `${-currentOffset}`,
              }}
            />
          );
        })}
      </svg>
      <div className="results-ring-label">
        <strong>
          {correct}/{Math.max(total, 1)}
        </strong>
      </div>
    </div>
  );
}

function MetricLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "danger" | "info" | "success";
}) {
  return (
    <div className={`results-metric-line ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ type }: { type: "correct" | "wrong" }) {
  return <span className={`results-status-badge ${type}`}>{type === "correct" ? "정답" : "오답"}</span>;
}

function ResultFactRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "danger" | "neutral";
}) {
  return (
    <div className="result-fact-row">
      <span>{label}</span>
      <strong className={`tone-${tone}`}>{value}</strong>
    </div>
  );
}

function StepCard({ step }: { step: QuestionProcessStep }) {
  return (
    <div className={`result-step-card ${step.status}`}>
      <span className={`result-step-badge ${step.status}`}>{step.order}</span>
      <div className="result-step-copy">
        <strong>{sanitizeText(step.summary, "단계를 불러오지 못했습니다.")}</strong>
        <p>{sanitizeText(step.detail, sanitizeText(step.summary, ""))}</p>
      </div>
    </div>
  );
}

function PrintNoteCard({ entry }: { entry: WrongNoteEntry }) {
  const {
    question,
    selection,
    answerPage,
    analysis,
    displayQuestionNumber,
    explanationRects,
  } = entry;

  return (
    <article className="print-note-page" data-print-note-card="true">
      <div className="print-note-head">
        <div>
          <h3 className="print-note-title">{displayQuestionNumber}번 오답 노트</h3>
        </div>
        <div className="print-note-meta">
          <span className="print-note-pill danger">오답</span>
          <span className="print-note-pill">{questionTypeLabel(question.questionType)}</span>
        </div>
      </div>

      <div className="print-note-grid">
        <section className="print-note-panel">
          <strong>문제</strong>
          {selection ? (
            <div className="print-note-image">
              <img alt={`${displayQuestionNumber}번 문제`} src={selection.snapshotDataUrl} />
            </div>
          ) : null}
        </section>

        <section className="print-note-panel">
          <strong>채점 정보</strong>
          <div className="print-note-facts">
            <div className="print-note-fact">
              <span>학생의 답</span>
              <strong>{displayAnswer(question.studentAnswer)}</strong>
            </div>
            <div className="print-note-fact">
              <span>정답</span>
              <strong>{displayAnswer(question.correctAnswer)}</strong>
            </div>
            <div className="print-note-fact">
              <span>판정</span>
              <strong>{question.isCorrect ? "정답" : "오답"}</strong>
            </div>
            <div className="print-note-fact">
              <span>신뢰도</span>
              <strong>{confidenceLabel(question.confidence)}</strong>
            </div>
          </div>
          <p className="print-note-copy">
            {sanitizeText(analysis?.oneLineSummary || question.feedback.mistakeReason, "오답 이유를 다시 확인해 보세요.")}
          </p>
        </section>

        <section className="print-note-panel wide">
          <strong>해설</strong>
          {answerPage && explanationRects.length > 0 ? (
            <div className="print-note-image">
              <CroppedImage imageDataUrl={answerPage.pageImageDataUrl} rects={explanationRects} />
            </div>
          ) : answerPage ? (
            <div className="print-note-image">
              <img alt={`${displayQuestionNumber}번 해설`} src={answerPage.pageImageDataUrl} />
            </div>
          ) : null}
          <p className="print-note-copy">
            {sanitizeText(
              analysis?.answerSheetBasis || question.feedback.explanation,
              "답지 해설을 다시 읽고 풀이 순서를 정리해 보세요."
            )}
          </p>
        </section>

        {analysis?.processSteps?.length ? (
          <section className="print-note-panel wide">
            <strong>오답 분석</strong>
            <div className="print-step-list">
              {analysis.processSteps.map((step) => (
                <div className={`print-step-card ${step.status}`} key={`${question.selectionId}-print-${step.order}`}>
                  <span className={`print-step-badge ${step.status}`}>{step.order}</span>
                  <div className="print-step-copy">
                    <strong>{sanitizeText(step.summary, "단계를 불러오지 못했습니다.")}</strong>
                    <p>{sanitizeText(step.detail, sanitizeText(step.summary, ""))}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
}

function CroppedImage({
  imageDataUrl,
  rects,
}: {
  imageDataUrl: string;
  rects: NormalizedRect[];
}) {
  const safeRects = rects
    .map((rect) => clampBoundingBox(rect))
    .filter((rect): rect is NormalizedRect => Boolean(rect));
  const [croppedSrc, setCroppedSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!imageDataUrl || safeRects.length === 0) {
      setCroppedSrc(null);
      return;
    }

    cropImageDataUrlSegments(imageDataUrl, safeRects)
      .then((nextSrc) => {
        if (!cancelled) {
          setCroppedSrc(nextSrc);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCroppedSrc(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imageDataUrl, safeRects]);

  if (safeRects.length === 0) {
    return <img alt="해설 원본" src={imageDataUrl} />;
  }

  if (croppedSrc) {
    return (
      <div className="crop-frame">
        <img alt="잘라낸 해설" className="crop-frame-resolved" src={croppedSrc} />
      </div>
    );
  }

  const styles = renderCropStyle(safeRects[0]);

  return (
    <div className="crop-frame">
      <img alt="잘라낸 해설" src={imageDataUrl} style={styles.img} />
    </div>
  );
}

function normalizeAnalysis(analysis?: QuestionDeepAnalysis | null) {
  if (!analysis) {
    return null;
  }

  const processSteps =
    analysis.processSteps && analysis.processSteps.length > 0
      ? analysis.processSteps.map((step, index) => ({
          order: step.order || index + 1,
          status: (step.status === "correct" ? "correct" : "incorrect") as "correct" | "incorrect",
          summary: sanitizeText(step.summary, "단계를 불러오지 못했습니다."),
          detail: sanitizeText(step.detail, sanitizeText(step.summary, "")),
        }))
      : [];
  const reasonSteps =
    analysis.reasonSteps && analysis.reasonSteps.length > 0
      ? analysis.reasonSteps
      : processSteps.map((step) => step.summary);
  const oneLineSummary = analysis.oneLineSummary || analysis.studyTip;

  if (reasonSteps.length === 0 && processSteps.length === 0 && !oneLineSummary) {
    return null;
  }

  return {
    processSteps,
    reasonSteps: reasonSteps.length > 0 ? reasonSteps : ["분석 결과를 아직 만들지 못했습니다."],
    answerSheetBasis: sanitizeText(analysis.answerSheetBasis, "답지 해설 요약을 아직 정리하지 못했습니다."),
    oneLineSummary: sanitizeText(oneLineSummary, "개념과 풀이 순서를 다시 확인해 보세요."),
  };
}

function displayAnswer(value: string) {
  const sanitized = sanitizeText(value, "X");
  return sanitized === "미인식" ? "X" : sanitized;
}

function confidenceLabel(confidence: number) {
  if (confidence >= 0.78) {
    return "높음";
  }

  if (confidence >= 0.46) {
    return "보통";
  }

  return "낮음";
}

function confidenceTone(confidence: number): "success" | "danger" | "neutral" {
  if (confidence >= 0.78) {
    return "success";
  }

  if (confidence >= 0.46) {
    return "neutral";
  }

  return "danger";
}

function renderWorkSummary(question: QuestionResult) {
  if (question.workEvidence.extractedWork) {
    return `풀이 흔적: ${sanitizeText(question.workEvidence.extractedWork, "")}`;
  }

  if (question.workEvidence.detectedMarks.length > 0) {
    return `표시 흔적: ${question.workEvidence.detectedMarks.join(", ")}`;
  }

  if (question.workEvidence.authenticity !== "unclear") {
    return `풀이 판정: ${authenticityLabel(question.workEvidence.authenticity)}`;
  }

  return "";
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
      return "문항";
  }
}

function authenticityLabel(type: QuestionResult["workEvidence"]["authenticity"]) {
  switch (type) {
    case "solved":
      return "직접 풀이";
    case "guessed":
      return "찍은 흔적";
    case "blank":
      return "풀이 없음";
    case "unclear":
      return "판단 어려움";
    default:
      return "판단 어려움";
  }
}

function buildReportQuote(rate: number) {
  if (rate >= 0.95) {
    return "Almost perfect, keep the rhythm.";
  }

  if (rate >= 0.75) {
    return "Great things take time.";
  }

  if (rate >= 0.5) {
    return "Step by step gets you there.";
  }

  return "One more round, a better result.";
}

function sanitizeText(value: string | undefined | null, fallback: string) {
  const normalized = stripNoticeText(value ?? "");

  if (!normalized) {
    return fallback;
  }

  const noisyMarkers = ["Unexpected end of JSON", "fallback", "GEMINI_API_KEY"];

  if (noisyMarkers.some((marker) => normalized.includes(marker))) {
    return fallback;
  }

  return normalized;
}
