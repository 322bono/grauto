"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExamMetadataForm } from "@/components/exam-metadata-form";
import { PdfAreaSelector } from "@/components/pdf-area-selector";
import { ResultsDashboard } from "@/components/results-dashboard";
import { throttleAiRequest } from "@/lib/ai-throttle";
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
  { id: "metadata", label: "?쒗뿕 ?뺣낫" },
  { id: "questions", label: "臾몄젣 ?곸뿭" },
  { id: "answers", label: "?듭븞 ?섏씠吏" },
  { id: "grade", label: "梨꾩젏 ?ㅽ뻾" },
  { id: "results", label: "寃곌낵 蹂닿린" }
];

const GRADE_PROGRESS_STEPS: GradingProgressStep[] = [
  {
    id: "prepare",
    label: "?먮즺 ?뺣━ 以?,
    detail: "?좏깮??臾몄젣? ?듭븞 ?섏씠吏瑜?梨꾩젏???뺤떇?쇰줈 ?뺣━?섍퀬 ?덉뼱??"
  },
  {
    id: "match",
    label: "臾명빆 留ㅼ묶 以?,
    detail: "臾몄젣 踰덊샇? ?듭? ?섏씠吏瑜?鍮꾧탳?댁꽌 ?뚮쭪? ?꾩튂瑜?李얘퀬 ?덉뼱??"
  },
  {
    id: "grade",
    label: "?먮룞 梨꾩젏 以?,
    detail: "?숈깮 ?듦낵 ?뺣떟??鍮꾧탳?섎ŉ 臾명빆蹂??뺤삤瑜??먯젙?섍퀬 ?덉뼱??"
  },
  {
    id: "feedback",
    label: "?댁꽕 ?뺣━ 以?,
    detail: "寃곌낵 ?붾㈃???ㅼ뼱媛??댁꽕怨?蹂듭뒿 ?ъ씤?몃? ?뺣━?섍퀬 ?덉뼱??"
  },
  {
    id: "save",
    label: "寃곌낵 ???以?,
    detail: "梨꾩젏 寃곌낵瑜??붾㈃怨?湲곕줉???덉쟾?섍쾶 諛섏쁺?섍퀬 ?덉뼱??"
  }
];

const APP_VERSION = "Beta v0.3.7";
const AI_REQUEST_MIN_GAP_MS = 15_000;

function getTodayLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const defaultMetadata: ExamMetadata = {
  subject: "?섑븰",
  examName: "",
  difficulty: "蹂댄넻",
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
      window.alert(error instanceof Error ? error.message : "Google 濡쒓렇?몄뿉 ?ㅽ뙣?덉뒿?덈떎.");
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
      window.alert(error instanceof Error ? error.message : "濡쒓렇?꾩썐???ㅽ뙣?덉뒿?덈떎.");
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
      window.alert(error instanceof Error ? error.message : "?대씪?곕뱶 ?낅줈?쒖뿉 ?ㅽ뙣?덉뒿?덈떎.");
      return record;
    } finally {
      setIsSyncing(false);
    }
  }

  async function gradeExam() {
    if (!questionFile || !effectiveAnswerFile || questionSelections.length === 0 || answerPages.length === 0) {
      window.alert("臾몄젣 ?곸뿭怨??듭븞 ?섏씠吏瑜?癒쇱? ?좏깮??二쇱꽭??");
      return;
    }

    const pendingQuestionImages = questionSelections.some(
      (selection) => isPlaceholderImageDataUrl(selection.snapshotDataUrl) || isPlaceholderImageDataUrl(selection.analysisDataUrl)
    );
    const pendingAnswerImages = answerPages.some(
      (page) => isPlaceholderImageDataUrl(page.pageImageDataUrl) || isPlaceholderImageDataUrl(page.analysisImageDataUrl)
    );

    if (pendingQuestionImages || pendingAnswerImages) {
      window.alert("?섏씠吏 ?대?吏瑜??꾩쭅 以鍮?以묒엯?덈떎. 1~2珥덈쭔 湲곕떎由????ㅼ떆 ?쒕룄??二쇱꽭??");
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
      window.alert("?좏깮???섏씠吏媛 ?덈Т 留롮븘????踰덉뿉 梨꾩젏 ?붿껌??蹂대궪 ???놁뒿?덈떎. ?듭븞 ?섏씠吏瑜??꾩슂??踰붿쐞濡?議곌툑留?以꾩뿬 二쇱꽭??");
      return;
    }

    try {
      setGradingProgressIndex(1);
      await throttleAiRequest(AI_REQUEST_MIN_GAP_MS);
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
      window.alert(error instanceof Error ? error.message : "梨꾩젏 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.");
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
        window.alert(error instanceof Error ? error.message : "?대씪?곕뱶 湲곕줉 媛깆떊???ㅽ뙣?덉뒿?덈떎.");
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
      window.alert("遺꾩꽍??臾명빆 ?뺣낫瑜?李얠? 紐삵뻽?듬땲??");
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

      await throttleAiRequest(AI_REQUEST_MIN_GAP_MS);
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
      window.alert(error instanceof Error ? error.message : "異붽? 遺꾩꽍 ?붿껌???ㅽ뙣?덉뒿?덈떎.");
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
    <main
      className={`shell landing-shell ${stage === "landing" ? "landing-active" : ""} ${stage === "landing" && !selectedMode ? "app-locked" : ""}`}
    >
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
          aria-label="硫붾돱 ?닿린"
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
              {isSigningIn ? "濡쒓렇??以?.." : "Google濡?濡쒓렇??}
            </button>
          </div>
        )}

        <div className="menu-meta menu-meta-auth">
          <Link className="drawer-record-link" href="/records" onClick={() => setMenuOpen(false)}>
            <span className="drawer-record-arrow">??/span>
            <span className="drawer-record-text">梨꾩젏 湲곕줉</span>
            <span className="drawer-record-chevron">??/span>
          </Link>
        </div>

        <div className="menu-drawer-foot">
          <span className="menu-foot-wordmark">Grauto</span>
          {authUser ? (
            <div className="menu-foot-actions">
              <button type="button" className="drawer-logout-button" onClick={handleSignOut}>
                濡쒓렇?꾩썐
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
                ?댁젣??<span className="accent">梨꾩젏源뚯?</span> ?먮룞?쇰줈.
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
                ?⑥씪 PDF ?뚯씪
              </button>
              <p>??PDF ?덉뿉 臾몄젣? ?듭?媛 紐⑤몢 ?덉쓣 ??/p>
            </div>

            <div className="sketch-choice">
              <button
                type="button"
                className={`sketch-mode-button ${selectedMode === "split" ? "active" : ""}`}
                onClick={() => handleModeChange("split")}
              >
                ???PDF ?뚯씪
              </button>
              <p>臾몄젣 PDF? ?듭? PDF媛 遺꾨━?섏뼱 ?덉쓣 ??/p>
            </div>
          </div>

          {selectedMode ? (
            <div className="landing-upload-dock">
              <div className="upload-deck">
                <UploadTile
                  id="question-file"
                  title={uploadMode === "single" ? "PDF ?뚯씪 ?낅줈?? : "臾몄젣吏 PDF ?낅줈??}
                  subtitle={uploadMode === "single" ? "臾몄젣? ?듭?媛 ?④퍡 ?ㅼ뼱 ?덈뒗 PDF" : "?ъ슜?먭? ??臾몄젣吏 PDF"}
                  file={questionFile}
                  onChange={(file) => setQuestionFile(file)}
                />

                {uploadMode === "split" ? (
                  <UploadTile
                    id="answer-file"
                    title="?듭? PDF ?낅줈??
                    subtitle="?뺣떟怨??댁꽕???ㅼ뼱 ?덈뒗 ?듭? PDF"
                    file={answerFile}
                    onChange={(file) => setAnswerFile(file)}
                  />
                ) : (
                  <div className="upload-hint-card">
                    <strong>?⑥씪 PDF 紐⑤뱶</strong>
                    <span>?낅줈?쒗븳 ??媛쒖쓽 PDF瑜?臾몄젣 ?섏씠吏? ?듭븞 ?섏씠吏 ?좏깮???④퍡 ?ъ슜?⑸땲??</span>
                  </div>
                )}
              </div>

              <div className="upload-footer">
                <button type="button" className="cta" disabled={!uploadReady} onClick={goToWorkspace}>
                  {uploadReady ? "?ㅼ쓬" : "PDF瑜?癒쇱? ?좏깮??二쇱꽭??}
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
                泥섏쓬 ?붾㈃?쇰줈
              </button>
              <div className="topbar-brand">
                <div className="brand-dot" />
                <span>Grauto Workspace</span>
              </div>
            </div>

            <div className="card pad stack step-shell">
              <div className="selector-head">
                <div>
                  <h2 className="section-title">?④퀎蹂?梨꾩젏 吏꾪뻾</h2>
                  <p className="subtle">??踰덉뿉 ?섎굹?⑸쭔 蹂댁씠?꾨줉 援ъ꽦?덉뒿?덈떎. ?꾨옒 ?④퀎 ?쒖꽌?濡?吏꾪뻾?섎㈃ ?⑸땲??</p>
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
                  <div className="subtle">?쒗뿕 ?뺣낫???좏깮 ?ы빆?낅땲?? 鍮꾩썙 ?щ룄 ?ㅼ쓬 ?④퀎濡??섏뼱媛????덉뒿?덈떎.</div>
                  <div className="button-row">
                    <button type="button" className="cta" onClick={moveToNextStep}>
                      ?ㅼ쓬
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "questions" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="臾몄젣 ?곸뿭 ?좏깮"
                  helperText="臾몄젣媛 ?ㅼ뼱 ?덈뒗 ?섏씠吏瑜?怨좊Ⅴ硫? 洹??덉쓽 臾명빆???먮룞?쇰줈 ?섎씪??梨꾩젏?⑹쑝濡??ъ슜?⑸땲??"
                  file={questionFile}
                  selectionMode="region"
                  accentLabel="臾몄젣 ?좏깮"
                  onRegionsChange={setQuestionSelections}
                />
                <div className="card pad step-actions">
                  <div className="subtle">?꾩옱 ?좏깮??臾몄젣 臾명빆: {selectionSummary.questionCount}媛?/div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?댁쟾
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.questionCount === 0} onClick={moveToNextStep}>
                      ?ㅼ쓬
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "answers" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="?듭븞 / ?댁꽕 ?섏씠吏 ?좏깮"
                  helperText="?뺣떟怨??댁꽕???ㅼ뼱 ?덈뒗 ?섏씠吏瑜?怨좊Ⅴ硫?臾명빆 踰덊샇? ?섏씠吏 ?뚰듃瑜?諛뷀깢?쇰줈 ?먮룞 留ㅼ묶?⑸땲??"
                  file={effectiveAnswerFile}
                  selectionMode="page"
                  accentLabel="?듭븞 ?섏씠吏 ?좏깮"
                  onPagesChange={setAnswerPages}
                />
                <div className="card pad step-actions">
                  <div className="subtle">?꾩옱 ?좏깮???듭븞 ?섏씠吏: {selectionSummary.answerCount}媛?/div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?댁쟾
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.answerCount === 0} onClick={moveToNextStep}>
                      ?ㅼ쓬
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
                      <h2 className="section-title">?먮룞 梨꾩젏 ?ㅽ뻾</h2>
                      <p className="subtle">?좏깮??臾명빆怨??듭븞 ?섏씠吏瑜?諛뷀깢?쇰줈 Gemini 2.5 Flash ?먮룞 梨꾩젏???ㅽ뻾?⑸땲??</p>
                    </div>
                    <div className="button-row">
                      <span className="status warn">臾몄젣 {selectionSummary.questionCount}媛?/span>
                      <span className="status warn">?듭븞 ?섏씠吏 {selectionSummary.answerCount}媛?/span>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div className="detail-row">
                      <strong>?낅줈??紐⑤뱶</strong>
                      <p style={{ marginBottom: 0 }}>{uploadMode === "single" ? "?⑥씪 PDF" : "???PDF"}</p>
                    </div>
                    <div className="detail-row">
                      <strong>臾몄젣 ?뚯씪</strong>
                      <p style={{ marginBottom: 0 }}>{questionFile?.name ?? "誘몄꽑??}</p>
                    </div>
                    <div className="detail-row">
                      <strong>?듭븞 ?뚯씪</strong>
                      <p style={{ marginBottom: 0 }}>{effectiveAnswerFile?.name ?? "誘몄꽑??}</p>
                    </div>
                  </div>
                </div>

                <div className="card pad step-actions">
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?댁쟾
                    </button>
                    <button type="button" className="cta" disabled={isSubmitting || isSyncing} onClick={gradeExam}>
                      {isSubmitting ? "梨꾩젏 以?.." : "梨꾩젏 ?쒖옉"}
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
                      <div className="subtle">梨꾩젏 湲곕줉? 硫붾돱??`梨꾩젏 湲곕줉` ?먮뒗 ?꾨옒 踰꾪듉?먯꽌 ?ㅼ떆 ?????덉뒿?덈떎.</div>
                      <div className="button-row">
                        <button type="button" className="cta ghost" onClick={() => setWorkspaceStep("grade")}>
                          梨꾩젏 ?④퀎濡??뚯븘媛湲?                        </button>
                        <Link className="cta ghost" href="/records">
                          梨꾩젏 湲곕줉 蹂닿린
                        </Link>
                        <button type="button" className="cta" onClick={() => setStage("landing")}>
                          ??PDF ?좏깮
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">?꾩쭅 梨꾩젏 寃곌낵媛 ?놁뒿?덈떎. 梨꾩젏 ?ㅽ뻾 ?④퀎?먯꽌 癒쇱? 梨꾩젏???쒖옉??二쇱꽭??</div>
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
        <h2 className="grading-overlay-title">梨꾩젏 吏꾪뻾 以?/h2>
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
          <span>臾몄젣 {questionCount}媛?/span>
          <span>?듭븞 ?섏씠吏 {answerCount}媛?/span>
          <span>{elapsedSeconds}珥?寃쎄낵</span>
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
      <div className={`upload-file-chip ${file ? "filled" : ""}`}>{file ? file.name : "PDF ?좏깮"}</div>
    </label>
  );
}




