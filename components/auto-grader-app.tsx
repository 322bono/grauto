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
  { id: "metadata", label: "?œí—˜ ?•ë³´" },
  { id: "questions", label: "ë¬¸ì œ ?ì—­" },
  { id: "answers", label: "?µì•ˆ ?˜ì´ì§€" },
  { id: "grade", label: "ì±„ì  ?¤í–‰" },
  { id: "results", label: "ê²°ê³¼ ë³´ê¸°" }
];

const GRADE_PROGRESS_STEPS: GradingProgressStep[] = [
  {
    id: "prepare",
    label: "?ë£Œ ?•ë¦¬ ì¤?,
    detail: "? íƒ??ë¬¸ì œ?€ ?µì•ˆ ?˜ì´ì§€ë¥?ì±„ì ???•ì‹?¼ë¡œ ?•ë¦¬?˜ê³  ?ˆì–´??"
  },
  {
    id: "match",
    label: "ë¬¸í•­ ë§¤ì¹­ ì¤?,
    detail: "ë¬¸ì œ ë²ˆí˜¸?€ ?µì? ?˜ì´ì§€ë¥?ë¹„êµ?´ì„œ ?Œë§?€ ?„ì¹˜ë¥?ì°¾ê³  ?ˆì–´??"
  },
  {
    id: "grade",
    label: "?ë™ ì±„ì  ì¤?,
    detail: "?™ìƒ ?µê³¼ ?•ë‹µ??ë¹„êµ?˜ë©° ë¬¸í•­ë³??•ì˜¤ë¥??ì •?˜ê³  ?ˆì–´??"
  },
  {
    id: "feedback",
    label: "?´ì„¤ ?•ë¦¬ ì¤?,
    detail: "ê²°ê³¼ ?”ë©´???¤ì–´ê°??´ì„¤ê³?ë³µìŠµ ?¬ì¸?¸ë? ?•ë¦¬?˜ê³  ?ˆì–´??"
  },
  {
    id: "save",
    label: "ê²°ê³¼ ?€??ì¤?,
    detail: "ì±„ì  ê²°ê³¼ë¥??”ë©´ê³?ê¸°ë¡???ˆì „?˜ê²Œ ë°˜ì˜?˜ê³  ?ˆì–´??"
  }
];

const APP_VERSION = "Beta v0.3.6";
const AI_REQUEST_MIN_GAP_MS = 15_000;

function getTodayLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const defaultMetadata: ExamMetadata = {
  subject: "?˜í•™",
  examName: "",
  difficulty: "ë³´í†µ",
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
      window.alert(error instanceof Error ? error.message : "Google ë¡œê·¸?¸ì— ?¤íŒ¨?ˆìŠµ?ˆë‹¤.");
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
      window.alert(error instanceof Error ? error.message : "ë¡œê·¸?„ì›ƒ???¤íŒ¨?ˆìŠµ?ˆë‹¤.");
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
      window.alert(error instanceof Error ? error.message : "?´ë¼?°ë“œ ?…ë¡œ?œì— ?¤íŒ¨?ˆìŠµ?ˆë‹¤.");
      return record;
    } finally {
      setIsSyncing(false);
    }
  }

  async function gradeExam() {
    if (!questionFile || !effectiveAnswerFile || questionSelections.length === 0 || answerPages.length === 0) {
      window.alert("ë¬¸ì œ ?ì—­ê³??µì•ˆ ?˜ì´ì§€ë¥?ë¨¼ì? ? íƒ??ì£¼ì„¸??");
      return;
    }

    const pendingQuestionImages = questionSelections.some(
      (selection) => isPlaceholderImageDataUrl(selection.snapshotDataUrl) || isPlaceholderImageDataUrl(selection.analysisDataUrl)
    );
    const pendingAnswerImages = answerPages.some(
      (page) => isPlaceholderImageDataUrl(page.pageImageDataUrl) || isPlaceholderImageDataUrl(page.analysisImageDataUrl)
    );

    if (pendingQuestionImages || pendingAnswerImages) {
      window.alert("?˜ì´ì§€ ?´ë?ì§€ë¥??„ì§ ì¤€ë¹?ì¤‘ì…?ˆë‹¤. 1~2ì´ˆë§Œ ê¸°ë‹¤ë¦????¤ì‹œ ?œë„??ì£¼ì„¸??");
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
      window.alert("? íƒ???˜ì´ì§€ê°€ ?ˆë¬´ ë§ì•„????ë²ˆì— ì±„ì  ?”ì²­??ë³´ë‚¼ ???†ìŠµ?ˆë‹¤. ?µì•ˆ ?˜ì´ì§€ë¥??„ìš”??ë²”ìœ„ë¡?ì¡°ê¸ˆë§?ì¤„ì—¬ ì£¼ì„¸??");
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
      window.alert(error instanceof Error ? error.message : "ì±„ì  ì¤??¤ë¥˜ê°€ ë°œìƒ?ˆìŠµ?ˆë‹¤.");
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
        window.alert(error instanceof Error ? error.message : "?´ë¼?°ë“œ ê¸°ë¡ ê°±ì‹ ???¤íŒ¨?ˆìŠµ?ˆë‹¤.");
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
      window.alert("ë¶„ì„??ë¬¸í•­ ?•ë³´ë¥?ì°¾ì? ëª»í–ˆ?µë‹ˆ??");
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
      window.alert(error instanceof Error ? error.message : "ì¶”ê? ë¶„ì„ ?”ì²­???¤íŒ¨?ˆìŠµ?ˆë‹¤.");
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
          aria-label="ë©”ë‰´ ?´ê¸°"
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
              {isSigningIn ? "ë¡œê·¸??ì¤?.." : "Googleë¡?ë¡œê·¸??}
            </button>
          </div>
        )}

        <div className="menu-meta menu-meta-auth">
          <Link className="drawer-record-link" href="/records" onClick={() => setMenuOpen(false)}>
            <span className="drawer-record-arrow">??/span>
            <span className="drawer-record-text">ì±„ì  ê¸°ë¡</span>
            <span className="drawer-record-chevron">??/span>
          </Link>
        </div>

        <div className="menu-drawer-foot">
          <span className="menu-foot-wordmark">Grauto</span>
          {authUser ? (
            <div className="menu-foot-actions">
              <button type="button" className="drawer-logout-button" onClick={handleSignOut}>
                ë¡œê·¸?„ì›ƒ
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
                ?´ì œ??<span className="accent">ì±„ì ê¹Œì?</span> ?ë™?¼ë¡œ.
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
                ?¨ì¼ PDF ?Œì¼
              </button>
              <p>??PDF ?ˆì— ë¬¸ì œ?€ ?µì?ê°€ ëª¨ë‘ ?ˆì„ ??/p>
            </div>

            <div className="sketch-choice">
              <button
                type="button"
                className={`sketch-mode-button ${selectedMode === "split" ? "active" : ""}`}
                onClick={() => handleModeChange("split")}
              >
                ?€??PDF ?Œì¼
              </button>
              <p>ë¬¸ì œ PDF?€ ?µì? PDFê°€ ë¶„ë¦¬?˜ì–´ ?ˆì„ ??/p>
            </div>
          </div>

          {selectedMode ? (
            <div className="landing-upload-dock">
              <div className="upload-deck">
                <UploadTile
                  id="question-file"
                  title={uploadMode === "single" ? "PDF ?Œì¼ ?…ë¡œ?? : "ë¬¸ì œì§€ PDF ?…ë¡œ??}
                  subtitle={uploadMode === "single" ? "ë¬¸ì œ?€ ?µì?ê°€ ?¨ê»˜ ?¤ì–´ ?ˆëŠ” PDF" : "?¬ìš©?ê? ??ë¬¸ì œì§€ PDF"}
                  file={questionFile}
                  onChange={(file) => setQuestionFile(file)}
                />

                {uploadMode === "split" ? (
                  <UploadTile
                    id="answer-file"
                    title="?µì? PDF ?…ë¡œ??
                    subtitle="?•ë‹µê³??´ì„¤???¤ì–´ ?ˆëŠ” ?µì? PDF"
                    file={answerFile}
                    onChange={(file) => setAnswerFile(file)}
                  />
                ) : (
                  <div className="upload-hint-card">
                    <strong>?¨ì¼ PDF ëª¨ë“œ</strong>
                    <span>?…ë¡œ?œí•œ ??ê°œì˜ PDFë¥?ë¬¸ì œ ?˜ì´ì§€?€ ?µì•ˆ ?˜ì´ì§€ ? íƒ???¨ê»˜ ?¬ìš©?©ë‹ˆ??</span>
                  </div>
                )}
              </div>

              <div className="upload-footer">
                <button type="button" className="cta" disabled={!uploadReady} onClick={goToWorkspace}>
                  {uploadReady ? "?¤ìŒ" : "PDFë¥?ë¨¼ì? ? íƒ??ì£¼ì„¸??}
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
                ì²˜ìŒ ?”ë©´?¼ë¡œ
              </button>
              <div className="topbar-brand">
                <div className="brand-dot" />
                <span>Grauto Workspace</span>
              </div>
            </div>

            <div className="card pad stack step-shell">
              <div className="selector-head">
                <div>
                  <h2 className="section-title">?¨ê³„ë³?ì±„ì  ì§„í–‰</h2>
                  <p className="subtle">??ë²ˆì— ?˜ë‚˜?©ë§Œ ë³´ì´?„ë¡ êµ¬ì„±?ˆìŠµ?ˆë‹¤. ?„ë˜ ?¨ê³„ ?œì„œ?€ë¡?ì§„í–‰?˜ë©´ ?©ë‹ˆ??</p>
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
                  <div className="subtle">?œí—˜ ?•ë³´??? íƒ ?¬í•­?…ë‹ˆ?? ë¹„ì›Œ ?¬ë„ ?¤ìŒ ?¨ê³„ë¡??˜ì–´ê°????ˆìŠµ?ˆë‹¤.</div>
                  <div className="button-row">
                    <button type="button" className="cta" onClick={moveToNextStep}>
                      ?¤ìŒ
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "questions" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="ë¬¸ì œ ?ì—­ ? íƒ"
                  helperText="ë¬¸ì œê°€ ?¤ì–´ ?ˆëŠ” ?˜ì´ì§€ë¥?ê³ ë¥´ë©? ê·??ˆì˜ ë¬¸í•­???ë™?¼ë¡œ ?˜ë¼??ì±„ì ?©ìœ¼ë¡??¬ìš©?©ë‹ˆ??"
                  file={questionFile}
                  selectionMode="region"
                  accentLabel="ë¬¸ì œ ? íƒ"
                  onRegionsChange={setQuestionSelections}
                />
                <div className="card pad step-actions">
                  <div className="subtle">?„ì¬ ? íƒ??ë¬¸ì œ ë¬¸í•­: {selectionSummary.questionCount}ê°?/div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?´ì „
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.questionCount === 0} onClick={moveToNextStep}>
                      ?¤ìŒ
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {workspaceStep === "answers" ? (
              <div className="step-panel stack">
                <PdfAreaSelector
                  title="?µì•ˆ / ?´ì„¤ ?˜ì´ì§€ ? íƒ"
                  helperText="?•ë‹µê³??´ì„¤???¤ì–´ ?ˆëŠ” ?˜ì´ì§€ë¥?ê³ ë¥´ë©?ë¬¸í•­ ë²ˆí˜¸?€ ?˜ì´ì§€ ?ŒíŠ¸ë¥?ë°”íƒ•?¼ë¡œ ?ë™ ë§¤ì¹­?©ë‹ˆ??"
                  file={effectiveAnswerFile}
                  selectionMode="page"
                  accentLabel="?µì•ˆ ?˜ì´ì§€ ? íƒ"
                  onPagesChange={setAnswerPages}
                />
                <div className="card pad step-actions">
                  <div className="subtle">?„ì¬ ? íƒ???µì•ˆ ?˜ì´ì§€: {selectionSummary.answerCount}ê°?/div>
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?´ì „
                    </button>
                    <button type="button" className="cta" disabled={selectionSummary.answerCount === 0} onClick={moveToNextStep}>
                      ?¤ìŒ
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
                      <h2 className="section-title">?ë™ ì±„ì  ?¤í–‰</h2>
                      <p className="subtle">? íƒ??ë¬¸í•­ê³??µì•ˆ ?˜ì´ì§€ë¥?ë°”íƒ•?¼ë¡œ Gemini 2.5 Flash ?ë™ ì±„ì ???¤í–‰?©ë‹ˆ??</p>
                    </div>
                    <div className="button-row">
                      <span className="status warn">ë¬¸ì œ {selectionSummary.questionCount}ê°?/span>
                      <span className="status warn">?µì•ˆ ?˜ì´ì§€ {selectionSummary.answerCount}ê°?/span>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div className="detail-row">
                      <strong>?…ë¡œ??ëª¨ë“œ</strong>
                      <p style={{ marginBottom: 0 }}>{uploadMode === "single" ? "?¨ì¼ PDF" : "?€??PDF"}</p>
                    </div>
                    <div className="detail-row">
                      <strong>ë¬¸ì œ ?Œì¼</strong>
                      <p style={{ marginBottom: 0 }}>{questionFile?.name ?? "ë¯¸ì„ ??}</p>
                    </div>
                    <div className="detail-row">
                      <strong>?µì•ˆ ?Œì¼</strong>
                      <p style={{ marginBottom: 0 }}>{effectiveAnswerFile?.name ?? "ë¯¸ì„ ??}</p>
                    </div>
                  </div>
                </div>

                <div className="card pad step-actions">
                  <div className="button-row">
                    <button type="button" className="cta ghost" onClick={moveToPreviousStep}>
                      ?´ì „
                    </button>
                    <button type="button" className="cta" disabled={isSubmitting || isSyncing} onClick={gradeExam}>
                      {isSubmitting ? "ì±„ì  ì¤?.." : "ì±„ì  ?œì‘"}
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
                      <div className="subtle">ì±„ì  ê¸°ë¡?€ ë©”ë‰´??`ì±„ì  ê¸°ë¡` ?ëŠ” ?„ë˜ ë²„íŠ¼?ì„œ ?¤ì‹œ ?????ˆìŠµ?ˆë‹¤.</div>
                      <div className="button-row">
                        <button type="button" className="cta ghost" onClick={() => setWorkspaceStep("grade")}>
                          ì±„ì  ?¨ê³„ë¡??Œì•„ê°€ê¸?                        </button>
                        <Link className="cta ghost" href="/records">
                          ì±„ì  ê¸°ë¡ ë³´ê¸°
                        </Link>
                        <button type="button" className="cta" onClick={() => setStage("landing")}>
                          ??PDF ? íƒ
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">?„ì§ ì±„ì  ê²°ê³¼ê°€ ?†ìŠµ?ˆë‹¤. ì±„ì  ?¤í–‰ ?¨ê³„?ì„œ ë¨¼ì? ì±„ì ???œì‘??ì£¼ì„¸??</div>
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
        <h2 className="grading-overlay-title">ì±„ì  ì§„í–‰ ì¤?/h2>
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
          <span>ë¬¸ì œ {questionCount}ê°?/span>
          <span>?µì•ˆ ?˜ì´ì§€ {answerCount}ê°?/span>
          <span>{elapsedSeconds}ì´?ê²½ê³¼</span>
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
      <div className={`upload-file-chip ${file ? "filled" : ""}`}>{file ? file.name : "PDF ? íƒ"}</div>
    </label>
  );
}



