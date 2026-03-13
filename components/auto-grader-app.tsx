"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExamMetadataForm } from "@/components/exam-metadata-form";
import { PdfAreaSelector } from "@/components/pdf-area-selector";
import { ResultsDashboard } from "@/components/results-dashboard";
import { observeAuthUser, signInWithGoogle, signOutUser } from "@/lib/firebase/auth";
import { syncExamRecordToCloud, updateCloudRecordSummary } from "@/lib/firebase/cloud-records";
import { listRecords, saveRecord } from "@/lib/local-db";
import { applyManualOverride } from "@/lib/summary";
import type {
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
  const [stage, setStage] = useState<"landing" | "workspace">("landing");
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("single");
  const [selectedMode, setSelectedMode] = useState<UploadMode | null>(null);
  const [metadata, setMetadata] = useState<ExamMetadata>(defaultMetadata);
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [questionSelections, setQuestionSelections] = useState<SelectedQuestionRegionPayload[]>([]);
  const [answerPages, setAnswerPages] = useState<AnswerPagePayload[]>([]);
  const [result, setResult] = useState<GradeResponsePayload | null>(null);
  const [records, setRecords] = useState<StoredExamRecord[]>([]);
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
  const [currentRecordCreatedAt, setCurrentRecordCreatedAt] = useState<string | null>(null);
  const [currentCloudSync, setCurrentCloudSync] = useState<CloudSyncState | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUserProfile | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  const effectiveAnswerFile = uploadMode === "single" ? questionFile : answerFile;
  const uploadReady = Boolean(questionFile && effectiveAnswerFile);

  useEffect(() => {
    setMetadata((current) => (current.takenAt ? current : { ...current, takenAt: getTodayLocalDate() }));
    void refreshRecords();

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

  async function refreshRecords() {
    const nextRecords = await listRecords();
    setRecords(nextRecords);
  }

  async function handleSignIn() {
    setIsSigningIn(true);

    try {
      const user = await signInWithGoogle();
      setSyncMessage(`${user.displayName} 계정으로 연결되었습니다. 이제 채점 결과와 PDF를 클라우드에 저장할 수 있습니다.`);
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
      setSyncMessage("로그아웃되었습니다. 이후 채점 결과는 현재 브라우저 로컬 기록에만 저장됩니다.");
      setCurrentCloudSync(undefined);
      setMenuOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "로그아웃에 실패했습니다.");
    }
  }

  async function persistLocalRecord(record: StoredExamRecord) {
    await saveRecord(record);
    await refreshRecords();
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
        onProgress: (progress, syncStage) => {
          setSyncMessage(`${syncStage} (${Math.round(progress * 100)}%)`);
        }
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
      setSyncMessage("PDF 업로드와 클라우드 기록 저장이 완료되었습니다.");

      return syncedRecord;
    } catch (error) {
      setSyncMessage("클라우드 동기화에 실패해 현재 결과는 로컬 기록에만 저장했습니다.");
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

    setIsSubmitting(true);

    const payload: GradeRequestPayload = {
      uploadMode,
      metadata,
      questionSelections,
      answerPages
    };

    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

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

      await persistLocalRecord(nextRecord);

      if (authUser) {
        nextRecord = await syncCurrentRecordToCloud(nextRecord, questionFile, effectiveAnswerFile);
        setCurrentCloudSync(nextRecord.cloudSync);
      } else {
        setSyncMessage("비로그인 상태입니다. 이번 채점 결과는 현재 브라우저 로컬 기록에만 저장됩니다.");
      }
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
        setSyncMessage("수동 채점 수정 내용이 클라우드 기록에도 반영되었습니다.");
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "클라우드 기록 갱신에 실패했습니다.");
      }
    }
  }

  function openRecord(record: StoredExamRecord) {
    setStage("workspace");
    setSelectedMode(record.uploadMode);
    setUploadMode(record.uploadMode);
    setCurrentRecordId(record.id);
    setCurrentRecordCreatedAt(record.createdAt);
    setCurrentCloudSync(record.cloudSync);
    setMetadata(record.metadata);
    setResult(record.result);
    setQuestionSelections(record.questionSelections);
    setAnswerPages(record.answerPages);
    setSyncMessage(record.cloudSync ? "이 기록은 클라우드와 동기화되어 있습니다." : "이 기록은 현재 브라우저 로컬에만 저장되어 있습니다.");
  }

  function handleModeChange(mode: UploadMode) {
    setSelectedMode(mode);
    setUploadMode(mode);
    setResult(null);
    setQuestionSelections([]);
    setAnswerPages([]);
    setSyncMessage("");

    if (mode === "single") {
      setAnswerFile(null);
    }
  }

  function goToWorkspace() {
    if (!uploadReady) {
      return;
    }

    setStage("workspace");
    setMenuOpen(false);
  }

  return (
    <main className={`shell landing-shell ${stage === "landing" ? "app-locked" : ""}`}>
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
            <p className="subtle" style={{ marginBottom: 0 }}>
              로그인하면 채점 기록과 PDF를 다른 기기에서도 다시 볼 수 있습니다.
            </p>
          </div>
        )}

        {syncMessage ? <div className="detail-row">{syncMessage}</div> : null}

        {authUser ? (
          <div className="menu-meta menu-meta-auth">
            <Link className="drawer-record-link" href="/records" onClick={() => setMenuOpen(false)}>
              <span className="drawer-record-arrow">↗</span>
              <span className="drawer-record-text">채점 기록</span>
              <span className="drawer-record-chevron">›</span>
            </Link>
          </div>
        ) : null}

        <div className="menu-drawer-foot">
          <span className="menu-foot-wordmark">Grauto</span>
          {authUser ? (
            <button type="button" className="drawer-logout-button" onClick={handleSignOut}>
              로그아웃
            </button>
          ) : null}
        </div>
      </aside>

      {stage === "landing" ? (
        <section className="intro-stage sketch-intro">
          <div className="sketch-copy">
            <h1 className="sketch-title">
              <span>이제는</span>
              <span className="accent">채점까지</span>
              <span> 자동으로.</span>
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
              <p>답지 PDF와 문제 PDF가 분리되어 있을 때</p>
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
                    subtitle="정답과 해설이 포함된 답지 PDF"
                    file={answerFile}
                    onChange={(file) => setAnswerFile(file)}
                  />
                ) : (
                  <div className="upload-hint-card">
                    <strong>단일 PDF 모드</strong>
                    <span>이 모드에서는 업로드한 한 개의 PDF를 문제 페이지와 답안 페이지 선택에 함께 사용합니다.</span>
                  </div>
                )}
              </div>

              <div className="upload-footer">
                <button type="button" className="cta" disabled={!uploadReady} onClick={goToWorkspace}>
                  {uploadReady ? "채점 화면으로 이동" : "PDF를 먼저 선택해 주세요"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          {syncMessage ? <div className="banner-card">{syncMessage}</div> : null}

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

            <section className="workspace-shell stack">
              <div className="workspace-header">
                <div>
                  <h2 className="section-title">채점 워크스페이스</h2>
                  <p className="subtle">시험 메타데이터를 입력하고 문제 영역과 답안 페이지를 선택한 뒤 자동 채점을 실행할 수 있습니다.</p>
                </div>
                <div className="workspace-status">
                  <span className="status ok">문제 PDF 준비됨</span>
                  {effectiveAnswerFile ? <span className="status ok">답안 PDF 준비됨</span> : null}
                </div>
              </div>

              <ExamMetadataForm metadata={metadata} onChange={setMetadata} />

              <PdfAreaSelector
                title="문제 영역 선택"
                helperText="문제 PDF에서 실제로 채점할 문항 부분만 드래그해서 선택해 주세요."
                file={questionFile}
                selectionMode="region"
                accentLabel="문제 선택"
                onRegionsChange={setQuestionSelections}
              />

              <PdfAreaSelector
                title="답안 / 해설 페이지 선택"
                helperText="정답과 해설이 들어 있는 페이지를 고르면 문항 번호와 페이지 힌트를 바탕으로 자동 매칭합니다."
                file={effectiveAnswerFile}
                selectionMode="page"
                accentLabel="답안 페이지 선택"
                onPagesChange={setAnswerPages}
              />

              <div className="card pad stack">
                <div className="selector-head">
                  <div>
                    <h2 className="section-title">자동 채점</h2>
                    <p className="subtle">선택한 문제 영역과 답안 페이지를 바탕으로 Vision 분석과 자동 채점을 실행합니다.</p>
                  </div>
                  <div className="button-row">
                    <span className="status warn">문제 {questionSelections.length}개</span>
                    <span className="status warn">답안 페이지 {answerPages.length}개</span>
                  </div>
                </div>

                <div className="button-row">
                  <button type="button" className="cta" disabled={isSubmitting || isSyncing} onClick={gradeExam}>
                    {isSubmitting ? "자동 채점 중..." : "채점 시작"}
                  </button>
                  <span className="subtle">
                    {authUser
                      ? "로그인 상태에서는 채점 결과와 PDF가 클라우드에 저장됩니다."
                      : "비로그인 상태에서는 결과가 현재 브라우저 로컬 기록에만 저장됩니다."}
                  </span>
                </div>
              </div>
            </section>
          </section>

          {result ? (
            <ResultsDashboard
              result={result}
              questionSelections={questionSelections}
              answerPages={answerPages}
              examName={metadata.examName}
              onManualOverride={handleManualOverride}
            />
          ) : null}

          <section className="library-grid">
            <div className="card pad stack">
              <div className="selector-head">
                <div>
                  <h2 className="section-title">로컬 채점 기록</h2>
                  <p className="subtle">이 브라우저에 저장된 최근 채점 기록을 바로 다시 열 수 있습니다.</p>
                </div>
                <span className="status warn">{records.length}개</span>
              </div>

              <div className="records-list">
                {records.length > 0 ? (
                  records.map((record) => (
                    <button type="button" className="record-card" key={record.id} onClick={() => openRecord(record)}>
                      <div className="record-head">
                        <strong>{record.metadata.examName || "이름 없는 시험지"}</strong>
                        <span className="status ok">{new Date(record.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      <div className="subtle">
                        {record.metadata.subject} · 정답 {record.result.summary.correctCount}/{record.result.summary.totalQuestions}
                      </div>
                      {record.cloudSync ? (
                        <div className="button-row" style={{ marginTop: 8 }}>
                          <span className="status ok">클라우드 동기화됨</span>
                        </div>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <div className="empty">아직 저장된 채점 기록이 없습니다.</div>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </main>
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
