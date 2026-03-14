"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExamMetadataForm } from "@/components/exam-metadata-form";
import { PdfAreaSelector } from "@/components/pdf-area-selector";
import { ResultsDashboard } from "@/components/results-dashboard";
import { resolveLocalExplanationRects } from "@/lib/explanation-region";
import { observeAuthUser, signInWithGoogle, signOutUser } from "@/lib/firebase/auth";
import { syncExamRecordToCloud, updateCloudRecordSummary } from "@/lib/firebase/cloud-records";
import { cropImageDataUrlSegments } from "@/lib/image-crop";
import { isPlaceholderImageDataUrl } from "@/lib/image-placeholder";
import { saveRecord } from "@/lib/local-db";
import { applyManualOverride } from "@/lib/summary";
import type {
  AnalyzeRequestPayload,
  AnalyzeResponsePayload,
  AnswerPagePayload,
  AuthUserProfile,
  CloudSyncState,
  ExamMetadata,
  GradeRequestPayload,
  GradeResponsePayload,
  SelectedQuestionRegionPayload,
  StoredExamRecord,
  UploadMode
} from "@/lib/types";

type AppStage = "landing" | "workspace";
type WorkspaceStep = "metadata" | "questions" | "answers" | "grade" | "results";
type GradingProgressStep = {
  id: string;
  label: string;
  detail: string;
};

const WORKSPACE_STEPS: Array<{ id: WorkspaceStep; label: string }> = [
  { id: "metadata", label: "시험 정보" },
  { id: "questions", label: "문제 영역" },
  { id: "answers", label: "답안 페이지" },
  { id: "grade", label: "채점 실행" },
  { id: "results", label: "결과 보기" }
];

const GRADE_PROGRESS_STEPS: GradingProgressStep[] = [
  {
    id: "prepare",
    label: "자료 정리 중",
    detail: "선택한 문제와 답안 페이지를 채점용 형식으로 정리하고 있어요."
  },
  {
    id: "match",
    label: "문항 매칭 중",
    detail: "문제 번호와 답지 페이지를 비교해서 알맞은 위치를 찾고 있어요."
  },
  {
    id: "grade",
    label: "자동 채점 중",
    detail: "학생 답과 정답을 비교하며 문항별 정오를 판정하고 있어요."
  },
  {
    id: "feedback",
    label: "해설 정리 중",
    detail: "결과 화면에 들어갈 해설과 복습 포인트를 정리하고 있어요."
  },
  {
    id: "save",
    label: "결과 저장 중",
    detail: "채점 결과를 화면과 기록에 안전하게 반영하고 있어요."
  }
];

const APP_VERSION = "v0.1.0";

function getTodayLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const defaultMetadata: ExamMetadata = {
  subject: "수학",
  examName: "",
  difficulty: "보통",
  durationMinutes: null,
  takenAt: "",
  memo: ""
};

export function AutoGraderApp() {
  const [stage, setStage] = useState<AppStage>("landing");
  const [workspaceStep, setWorkspaceStep] = useState<WorkspaceStep>("metadata");
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("single");
  const [selectedMode, setSelectedMode] = useState<UploadMode | null>(null);
  const [metadata, setMetadata] = useState<ExamMetadata>(defaultMetadata);
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [questionSelections, setQuestionSelections] = useState<SelectedQuestionRegionPayload[]>([]);
  const [answerPages, setAnswerPages] = useState<AnswerPagePayload[]>([]);
  const [result, setResult] = useState<GradeResponsePayload | null>(null);
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
  const [currentRecordCreatedAt, setCurrentRecordCreatedAt] = useState<string | null>(null);
  const [currentCloudSync, setCurrentCloudSync] = useState<CloudSyncState | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUserProfile | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [gradingProgressIndex, setGradingProgressIndex] = useState(0);
  const [gradingElapsedSeconds, setGradingElapsedSeconds] = useState(0);

  const effectiveAnswerFile = uploadMode === "single" ? questionFile : answerFile;
  const uploadReady = Boolean(questionFile && effectiveAnswerFile);
  const currentStepIndex = WORKSPACE_STEPS.findIndex((step) => step.id === workspaceStep);
  const currentGradingStep = GRADE_PROGRESS_STEPS[Math.min(gradingProgressIndex, GRADE_PROGRESS_STEPS.length - 1)];
  const gradingProgressPercent = Math.round(((Math.min(gradingProgressIndex, GRADE_PROGRESS_STEPS.length - 1) + 1) / GRADE_PROGRESS_STEPS.length) * 100);

  const selectionSummary = useMemo(
    () => ({
      questionCount: questionSelections.length,
      answerCount: answerPages.length
    }),
    [answerPages.length, questionSelections.length]
  );

  useEffect(() => {
    setMetadata((current) => (current.takenAt ? current : { ...current, takenAt: getTodayLocalDate() }));

    const unsubscribe = observeAuthUser((user) => {
      setAuthUser(user);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = stage === "landing" ? "hidden" : "";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [stage]);

  useEffect(() => {
    if (stage === "workspace") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [stage, workspaceStep]);

  useEffect(() => {
    if (!isSubmitting) {
      setGradingElapsedSeconds(0);
      return;
    }

    const stepTimer = window.setInterval(() => {
      setGradingProgressIndex((current) => Math.min(current + 1, GRADE_PROGRESS_STEPS.length - 2));
    }, 1800);
    const elapsedTimer = window.setInterval(() => {
      setGradingElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => {
      window.clearInterval(stepTimer);
      window.clearInterval(elapsedTimer);
    };
  }, [isSubmitting]);

  async function handleSignIn() {
    setIsSigningIn(true);

    try {
      await signInWithGoogle();
      setMenuOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Google 로그인에 실패했습니다.");
    } finally {
      setIsSigningIn(false);
    }
  }

  async function handleSignOut() {
    try {
      await signOutUser();
      setCurrentCloudSync(undefined);
      setMenuOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "로그아웃에 실패했습니다.");
    }
  }

  async function persistLocalRecord(record: StoredExamRecord) {
    await saveRecord(record);
  }

  async function syncCurrentRecordToCloud(record: StoredExamRecord, questionPdf: File, answerPdf: File) {
    if (!authUser) {
      return record;
    }

    setIsSyncing(true);

    try {
      const cloudRecord = await syncExamRecordToCloud({
        ownerUid: authUser.uid,
        record,
        questionFile: questionPdf,
        answerFile: answerPdf,
        onProgress: () => {}
      });

      const cloudSync: CloudSyncState = {
        remoteId: cloudRecord.id,
        syncedAt: cloudRecord.updatedAt,
        questionPdfUrl: cloudRecord.questionPdfUrl,
        answerPdfUrl: cloudRecord.answerPdfUrl,
        detailJsonUrl: cloudRecord.detailJsonUrl,
        detailStoragePath: cloudRecord.detailStoragePath
      };

      const syncedRecord: StoredExamRecord = {
        ...record,
        cloudSync
      };

      await persistLocalRecord(syncedRecord);
      setCurrentCloudSync(cloudSync);

      return syncedRecord;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "클라우드 업로드에 실패했습니다.");
      return record;
    } finally {
      setIsSyncing(false);
    }
  }

  async function gradeExam() {
    if (!questionFile || !effectiveAnswerFile || questionSelections.length === 0 || answerPages.length === 0) {
      window.alert("문제 영역과 답안 페이지를 먼저 선택해 주세요.");
      return;
    }

    const pendingQuestionImages = questionSelections.some(
      (selection) => isPlaceholderImageDataUrl(selection.snapshotDataUrl) || isPlaceholderImageDataUrl(selection.analysisDataUrl)
    );
    const pendingAnswerImages = answerPages.some(
      (page) => isPlaceholderImageDataUrl(page.pageImageDataUrl) || isPlaceholderImageDataUrl(page.analysisImageDataUrl)
    );

    if (pendingQuestionImages || pendingAnswerImages) {
      window.alert("페이지 이미지를 아직 준비 중입니다. 1~2초만 기다린 뒤 다시 시도해 주세요.");
      return;
    }

    setGradingProgressIndex(0);
    setGradingElapsedSeconds(0);
    setIsSubmitting(true);

    const payload: GradeRequestPayload = {
      uploadMode,
      metadata,
      questionSelections: questionSelections.map(({ analysisDataUrl, ...selection }) => ({
        ...selection,
        snapshotDataUrl: analysisDataUrl ?? selection.snapshotDataUrl
      })),
      answerPages: answerPages.map(({ analysisImageDataUrl, ...page }) => ({
        ...page,
        pageImageDataUrl: analysisImageDataUrl ?? page.pageImageDataUrl
      }))
    };
    const requestBody = JSON.stringify(payload);
    const payloadBytes = new TextEncoder().encode(requestBody).length;

    if (payloadBytes > 3_800_000) {
      setIsSubmitting(false);
      window.alert("선택한 페이지가 너무 많아서 한 번에 채점 요청을 보낼 수 없습니다. 답안 페이지를 필요한 범위로 조금만 줄여 주세요.");
      return;
    }

    try {
      setGradingProgressIndex(1);
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: requestBody
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setGradingProgressIndex(3);
      const nextResult = (await response.json()) as GradeResponsePayload;
      const createdAt = new Date().toISOString();
      const recordId = crypto.randomUUID();
      let nextRecord: StoredExamRecord = {
        id: recordId,
        createdAt,
        uploadMode,
        metadata,
        questionFileName: questionFile.name,
        answerFileName: effectiveAnswerFile.name,
        questionSelections,
        answerPages,
        result: nextResult
      };

      setCurrentRecordId(recordId);
      setCurrentRecordCreatedAt(createdAt);
      setCurrentCloudSync(undefined);
      setResult(nextResult);
      setGradingProgressIndex(4);

      await persistLocalRecord(nextRecord);

      if (authUser) {
        nextRecord = await syncCurrentRecordToCloud(nextRecord, questionFile, effectiveAnswerFile);
        setCurrentCloudSync(nextRecord.cloudSync);
      }

      setWorkspaceStep("results");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "채점 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleManualOverride(selectionId: string, isCorrect: boolean) {
    if (!result || !currentRecordId || !currentRecordCreatedAt) {
      return;
    }

    const updated = applyManualOverride(result, selectionId, isCorrect);
    setResult(updated);

    const updatedRecord: StoredExamRecord = {
      id: currentRecordId,
      createdAt: currentRecordCreatedAt,
      uploadMode,
      metadata,
      questionFileName: questionFile?.name ?? "unknown-question.pdf",
      answerFileName: effectiveAnswerFile?.name ?? "unknown-answer.pdf",
      questionSelections,
      answerPages,
      result: updated,
      cloudSync: currentCloudSync
    };

    await persistLocalRecord(updatedRecord);

    if (authUser && currentCloudSync) {
      try {
        await updateCloudRecordSummary(authUser.uid, updatedRecord, updated);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "클라우드 기록 갱신에 실패했습니다.");
      }
    }
  }

  async function handleRequestAnalysis(selectionId: string) {
    if (!result || !currentRecordId || !currentRecordCreatedAt) {
      return;
    }

    const question = result.questions.find((item) => item.selectionId === selectionId);
    const selection = questionSelections.find((item) => item.id === selectionId);
    const answerPage = question?.matchedAnswerPageNumber
      ? answerPages.find((item) => item.pageNumber === question.matchedAnswerPageNumber) ?? null
      : null;

    if (!question || !selection) {
      window.alert("분석할 문항 정보를 찾지 못했습니다.");
      return;
    }

    try {
      const pageQuestions = question?.matchedAnswerPageNumber
        ? result.questions.filter((item) => item.matchedAnswerPageNumber === question.matchedAnswerPageNumber)
        : question
          ? [question]
          : [];
      const displayQuestionNumber = selection.questionNumberHint ?? question.questionNumber ?? selection.displayOrder ?? 1;
      const localExplanationRects = question
        ? resolveLocalExplanationRects(question, pageQuestions, answerPage, displayQuestionNumber)
        : [];
      const explanationCropDataUrl =
        answerPage && localExplanationRects.length > 0
          ? await cropImageDataUrlSegments(answerPage.pageImageDataUrl, localExplanationRects)
          : null;

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          metadata,
          question,
          selection,
          answerPage,
          explanationCropDataUrl
        } satisfies AnalyzeRequestPayload)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const { analysis } = (await response.json()) as AnalyzeResponsePayload;
      const updatedResult: GradeResponsePayload = {
        ...result,
        questions: result.questions.map((item) =>
          item.selectionId === selectionId
            ? {
                ...item,
                deepAnalysis: analysis
              }
            : item
        )
      };

      setResult(updatedResult);

      const updatedRecord: StoredExamRecord = {
        id: currentRecordId,
        createdAt: currentRecordCreatedAt,
        uploadMode,
        metadata,
        questionFileName: questionFile?.name ?? "unknown-question.pdf",
        answerFileName: effectiveAnswerFile?.name ?? "unknown-answer.pdf",
        questionSelections,
        answerPages,
        result: updatedResult,
        cloudSync: currentCloudSync
      };

      await persistLocalRecord(updatedRecord);

      if (authUser && currentCloudSync) {
        await updateCloudRecordSummary(authUser.uid, updatedRecord, updatedResult);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "추가 분석 요청에 실패했습니다.");
    }
  }

  function resetWorkspaceStep(step: WorkspaceStep) {
    setWorkspaceStep(step);
  }

  function handleModeChange(mode: UploadMode) {
    setSelectedMode(mode);
    setUploadMode(mode);
    setQuestionFile(null);
    setAnswerFile(null);
    setQuestionSelections([]);
    setAnswerPages([]);
    setResult(null);
    setCurrentRecordId(null);
    setCurrentRecordCreatedAt(null);
    setCurrentCloudSync(undefined);
    setWorkspaceStep("metadata");

    if (mode === "single") {
      setAnswerFile(null);
    }
  }

  function goToWorkspace() {
    if (!uploadReady) {
      return;
    }

    setStage("workspace");
    setWorkspaceStep("metadata");
    setMenuOpen(false);
  }

  function moveToNextStep() {
    if (workspaceStep === "metadata") {
      setWorkspaceStep("questions");
      return;
    }

    if (workspaceStep === "questions" && questionSelections.length > 0) {
      setWorkspaceStep("answers");
      return;
    }

    if (workspaceStep === "answers" && answerPages.length > 0) {
      setWorkspaceStep("grade");
    }
  }

  function moveToPreviousStep() {
    if (workspaceStep === "results") {
      setWorkspaceStep("grade");
      return;
    }

    if (workspaceStep === "grade") {
      setWorkspaceStep("answers");
      return;
    }

    if (workspaceStep === "answers") {
      setWorkspaceStep("questions");
      return;
    }

    if (workspaceStep === "questions") {
      setWorkspaceStep("metadata");
    }
  }

  return (
    <main className={`shell landing-shell ${stage === "landing" && !selectedMode ? "app-locked" : ""}`}>
      {isSubmitting ? (
        <GradingProgressOverlay
          currentStep={currentGradingStep}
          progressPercent={gradingProgressPercent}
          progressIndex={gradingProgressIndex}
          elapsedSeconds={gradingElapsedSeconds}
          questionCount={selectionSummary.questionCount}
          answerCount={selectionSummary.answerCount}
        />
      ) : null}

      <div className="landing-header">
        <button
          type="button"
          className={`menu-trigger ${menuOpen ? "open" : ""}`}
          aria-label="메뉴 열기"
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span />
          <span />
          <span />
        </button>

        <div className="landing-corner-brand">
          <span className="landing-corner-wordmark">Grauto</span>
        </div>
      </div>

      <div className={`menu-backdrop ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen(false)} />

      <aside className={`menu-drawer ${menuOpen ? "open" : ""} ${authUser ? "auth" : "guest"}`}>
        <div className="menu-drawer-head">
          <strong className="menu-drawer-label">Grauto Menu</strong>
          <button type="button" className="drawer-close" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)}>
            <span />
            <span />
            <span />
          </button>
        </div>

        {authUser ? (
          <div className="menu-profile menu-profile-auth">
            <span className="menu-title">WELCOME,</span>
            <strong className="menu-user-name">{authUser.displayName}</strong>
            <span className="menu-user-email">{authUser.email}</span>
          </div>
        ) : (
          <div className="menu-profile menu-profile-guest">
            <button type="button" className="drawer-login-button" disabled={isSigningIn} onClick={handleSignIn}>
              {isSigningIn ? "로그인 중..." : "Google로 로그인"}
            </button>
          </div>
        )}

        <div className="menu-meta menu-meta-auth">
          <Link className="drawer-record-link" href="/records" onClick={() => setMenuOpen(false)}>
            <span className="drawer-record-arrow">↗</span>
            <span className="drawer-record-text">채점 기록</span>
            <span className="drawer-record-chevron">›</span>
          </Link>
        </div>

        <div className="menu-drawer-foot">
          <span className="menu-foot-wordmark">Grauto</span>
          {authUser ? (
            <div className="menu-foot-actions">
              <button type="button" className="drawer-logout-button" onClick={handleSignOut}>
                로그아웃
              </button>
              <span className="drawer-version">{APP_VERSION}</span>
            </div>
          ) : null}
        </div>
      </aside>

      {stage === "landing" ? (
        <section className={`intro-stage sketch-intro ${selectedMode ? "with-upload" : ""}`}>
          <div className="sketch-copy">
            <h1 className="sketch-title">
              <span className="sketch-title-line">
                이제는 <span className="accent">채점까지</span> 자동으로.
              </span>
            </h1>
            <div className="sketch-subtitle">Grauto</div>
          </div>

          <div className="sketch-choice-row">
            <div className="sketch-choice">
              <button
                type="button"
                className={`sketch-mode-button ${selectedMode === "single" ? "active" : ""}`}
                onClick={() => handleModeChange("single")}
              >
                단일 PDF 파일
              </button>
              <p>한 PDF 안에 문제와 답지가 모두 있을 때</p>
            </div>

            <div className="sketch-choice">
              <button
                type="button"
                className={`sketch-mode-button ${selectedMode === "split" ? "active" : ""}`}
                onClick={() => handleModeChange("split")}
              >
                듀얼 PDF 파일
              </button>
              <p>문제 PDF와 답지 PDF가 분리되어 있을 때</p>
            </div>
          </div>

          {selectedMode ? (
            <div className="landing-upload-dock">
              <div className="upload-deck">
                <UploadTile
                  id="question-file"
                  title={uploadMode === "single" ? "PDF 파일 업로드" : "문제지 PDF 업로드"}
                  subtitle={uploadMode === "single" ? "문제와 답지가 함께 들어 있는 PDF" : "사용자가 푼 문제지 PDF"}
                  file={questionFile}
                  onChange={(file) => setQuestionFile(file)}
                />

                {uploadMode === "split" ? (
                  <UploadTile
                    id="answer-file"
                    title="답지 PDF 업로드"
                    subtitle="정답과 해설이 들어 있는 답지 PDF"
                    file={answerFile}
                    onChange={(file) => setAnswerFile(file)}
                  />
                ) : (
                  <div className="upload-hint-card">
                    <strong>단일 PDF 모드</strong>
                    <span>업로드한 한 개의 PDF를 문제 페이지와 답안 페이지 선택에 함께 사용합니다.</span>
                  </div>
                )}
              </div>

              <div className="upload-footer">
                <button type="button" className="cta" disabled={!uploadReady} onClick={goToWorkspace}>
                  {uploadReady ? "다음" : "PDF를 먼저 선택해 주세요"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <section className="workspace-shell stack">
            <div className="workspace-top">
              <button type="button" className="cta ghost" onClick={() => setStage("landing")}>
                처음 화면으로
              </button>
              <div className="topbar-brand">
                <div className="brand-dot" />
                <span>Grauto Workspace</span>
              </div>
            </div>

            <div className="card pad stack step-shell">
              <div className="selector-head">
                <div>
                  <h2 className="section-title">단계별 채점 진행</h2>
                  <p className="subtle">한 번에 하나씩만 보이도록 구성했습니다. 아래 단계 순서대로 진행하면 됩니다.</p>
                </div>
                <span className="status ok">
                  {currentStepIndex + 1} / {WORKSPACE_STEPS.length}
                </span>
              </div>

              <div className="step-progress">
                {WORKSPACE_STEPS.map((step, index) => {
                  const isActive = step.id === workspaceStep;
                  const isComplete = index < currentStepIndex;
                  const isClickable = isComplete || step.id === "metadata" || (step.id === "results" && Boolean(result));

                  return (
                    <button
                      key={step.id}
                      type="button"
                      className={`step-pill ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`}
                      disabled={!isClickable}
                      onClick={() => resetWorkspaceStep(step.id)}
                    >
                      <span>{index + 1}</span>
                      <strong>{step.label}</strong>
                    </button>
                  );
                })}
              </div>
            </div>

            {workspaceStep === "metadata" ? (
              <div className="step-panel stack">
                <ExamMetadataForm metadata={metadata} onChange={setMetadata} />
                <div className="card pad step-actions">
                  <div className="subtle">시험 정보는 선택 사항입니다. 비워 둬도 다음 단계로 넘어갈 수 있습니다.</div>
                  <div className="button-row">
                    <button type="button" className="cta" onClick={moveToNextStep}>
                      다음
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "questions" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="문제 영역 선택"
                  helperText="문제가 들어 있는 페이지를 고르면, 그 안의 문항을 자동으로 잘라서 채점용으로 사용합니다."
                  file={questionFile}
                  selectionMode="region"
                  accentLabel="문제 선택"
                  onRegionsChange={setQuestionSelections}
                />
                <div className="card pad step-actions">
                  <div className="subtle">현재 선택한 문제 문항: {selectionSummary.questionCount}개</div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      이전
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.questionCount === 0} onClick={moveToNextStep}>
                      다음
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "answers" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="답안 / 해설 페이지 선택"
                  helperText="정답과 해설이 들어 있는 페이지를 고르면 문항 번호와 페이지 힌트를 바탕으로 자동 매칭합니다."
                  file={effectiveAnswerFile}
                  selectionMode="page"
                  accentLabel="답안 페이지 선택"
                  onPagesChange={setAnswerPages}
                />
                <div className="card pad step-actions">
                  <div className="subtle">현재 선택한 답안 페이지: {selectionSummary.answerCount}개</div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      이전
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.answerCount === 0} onClick={moveToNextStep}>
                      다음
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "grade" ? (
              <div className="step-panel stack">
                <div className="card pad stack">
                  <div className="selector-head">
                    <div>
                      <h2 className="section-title">자동 채점 실행</h2>
                      <p className="subtle">선택한 문항과 답안 페이지를 바탕으로 Gemini 2.5 Flash 자동 채점을 실행합니다.</p>
                    </div>
                    <div className="button-row">
                      <span className="status warn">문제 {selectionSummary.questionCount}개</span>
                      <span className="status warn">답안 페이지 {selectionSummary.answerCount}개</span>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div className="detail-row">
                      <strong>업로드 모드</strong>
                      <p style={{ marginBottom: 0 }}>{uploadMode === "single" ? "단일 PDF" : "듀얼 PDF"}</p>
                    </div>
                    <div className="detail-row">
                      <strong>문제 파일</strong>
                      <p style={{ marginBottom: 0 }}>{questionFile?.name ?? "미선택"}</p>
                    </div>
                    <div className="detail-row">
                      <strong>답안 파일</strong>
                      <p style={{ marginBottom: 0 }}>{effectiveAnswerFile?.name ?? "미선택"}</p>
                    </div>
                  </div>
                </div>

                <div className="card pad step-actions">
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      이전
                    </button>
                    <button type="button" className="cta" disabled={isSubmitting || isSyncing} onClick={gradeExam}>
                      {isSubmitting ? "채점 중..." : "채점 시작"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "results" ? (
              <div className="step-panel stack">
                {result ? (
                  <>
                    <ResultsDashboard
                      result={result}
                      questionSelections={questionSelections}
                      answerPages={answerPages}
                      examName={metadata.examName}
                      onManualOverride={handleManualOverride}
                      onRequestAnalysis={handleRequestAnalysis}
                    />

                    <div className="card pad step-actions">
                      <div className="subtle">채점 기록은 메뉴의 `채점 기록` 또는 아래 버튼에서 다시 열 수 있습니다.</div>
                      <div className="button-row">
                        <button type="button" className="cta ghost" onClick={() => setWorkspaceStep("grade")}>
                          채점 단계로 돌아가기
                        </button>
                        <Link className="cta ghost" href="/records">
                          채점 기록 보기
                        </Link>
                        <button type="button" className="cta" onClick={() => setStage("landing")}>
                          새 PDF 선택
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">아직 채점 결과가 없습니다. 채점 실행 단계에서 먼저 채점을 시작해 주세요.</div>
                )}
              </div>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

function GradingProgressOverlay({
  currentStep,
  progressPercent,
  progressIndex,
  elapsedSeconds,
  questionCount,
  answerCount
}: {
  currentStep: GradingProgressStep;
  progressPercent: number;
  progressIndex: number;
  elapsedSeconds: number;
  questionCount: number;
  answerCount: number;
}) {
  return (
    <div className="grading-overlay" aria-live="polite" aria-busy="true">
      <div className="grading-overlay-card">
        <span className="grading-overlay-kicker">Grauto</span>
        <h2 className="grading-overlay-title">채점 진행 중</h2>
        <p className="grading-overlay-copy">{currentStep.detail}</p>

        <div className="grading-progress-shell" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
          <div className="grading-progress-bar">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <strong>{progressPercent}%</strong>
        </div>

        <div className="grading-current-step">
          <span className="grading-current-step-index">
            {Math.min(progressIndex + 1, GRADE_PROGRESS_STEPS.length)} / {GRADE_PROGRESS_STEPS.length}
          </span>
          <strong>{currentStep.label}</strong>
        </div>

        <div className="grading-step-list">
          {GRADE_PROGRESS_STEPS.map((step, index) => {
            const state = index < progressIndex ? "done" : index === progressIndex ? "active" : "idle";

            return (
              <div key={step.id} className={`grading-step-chip ${state}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grading-overlay-meta">
          <span>문제 {questionCount}개</span>
          <span>답안 페이지 {answerCount}개</span>
          <span>{elapsedSeconds}초 경과</span>
        </div>
      </div>
    </div>
  );
}

function UploadTile({
  id,
  title,
  subtitle,
  file,
  onChange
}: {
  id: string;
  title: string;
  subtitle: string;
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <label className="upload-tile" htmlFor={id}>
      <input id={id} type="file" accept="application/pdf" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
      <div className="upload-tile-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className={`upload-file-chip ${file ? "filled" : ""}`}>{file ? file.name : "PDF 선택"}</div>
    </label>
  );
}
