"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ResultsDashboard } from "@/components/results-dashboard";
import { resolveLocalExplanationRects } from "@/lib/explanation-region";
import { observeAuthUser } from "@/lib/firebase/auth";
import {
  deleteCloudRecord,
  fetchCloudRecordDetail,
  subscribeToCloudRecords,
  updateCloudRecordSummary
} from "@/lib/firebase/cloud-records";
import { cropImageDataUrlSegments } from "@/lib/image-crop";
import { deleteRecord, listRecords, saveRecord } from "@/lib/local-db";
import { applyManualOverride } from "@/lib/summary";
import type {
  AnalyzeRequestPayload,
  AnalyzeResponsePayload,
  AuthUserProfile,
  CloudExamRecord,
  CloudSyncState,
  StoredExamRecord
} from "@/lib/types";

function buildCloudSync(record: CloudExamRecord): CloudSyncState {
  return {
    remoteId: record.id,
    syncedAt: record.updatedAt,
    questionPdfUrl: record.questionPdfUrl,
    answerPdfUrl: record.answerPdfUrl,
    detailJsonUrl: record.detailJsonUrl,
    detailStoragePath: record.detailStoragePath
  };
}

function previewForLocalRecord(record: StoredExamRecord) {
  return record.questionSelections[0]?.snapshotDataUrl ?? record.answerPages[0]?.pageImageDataUrl ?? "";
}

export function RecordsPage() {
  const [authUser, setAuthUser] = useState<AuthUserProfile | null>(null);
  const [localRecords, setLocalRecords] = useState<StoredExamRecord[]>([]);
  const [cloudRecords, setCloudRecords] = useState<CloudExamRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<StoredExamRecord | null>(null);
  const [selectedCloudRecord, setSelectedCloudRecord] = useState<CloudExamRecord | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  useEffect(() => {
    void refreshLocalRecords();

    const unsubscribe = observeAuthUser((user) => {
      setAuthUser(user);

      if (!user) {
        setCloudRecords([]);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    return subscribeToCloudRecords(authUser.uid, setCloudRecords);
  }, [authUser]);

  async function refreshLocalRecords() {
    const nextRecords = await listRecords();
    setLocalRecords(nextRecords);
  }

  const localByRemoteId = useMemo(
    () =>
      new Map(
        localRecords
          .filter((record) => record.cloudSync?.remoteId)
          .map((record) => [record.cloudSync?.remoteId as string, record])
      ),
    [localRecords]
  );

  const cloudOnlyRecords = useMemo(
    () => cloudRecords.filter((record) => !localByRemoteId.has(record.id)),
    [cloudRecords, localByRemoteId]
  );

  async function handleViewLocalRecord(record: StoredExamRecord) {
    setSelectedCloudRecord(
      record.cloudSync ? cloudRecords.find((cloudRecord) => cloudRecord.id === record.cloudSync?.remoteId) ?? null : null
    );
    setSelectedRecord(record);
  }

  async function handleViewCloudRecord(record: CloudExamRecord) {
    const localRecord = localByRemoteId.get(record.id);

    if (localRecord) {
      await handleViewLocalRecord(localRecord);
      return;
    }

    if (!record.detailJsonUrl) {
      return;
    }

    setIsLoadingDetail(true);
    setSelectedCloudRecord(record);

    try {
      const detail = await fetchCloudRecordDetail(record.detailJsonUrl);
      const enrichedRecord: StoredExamRecord = {
        ...detail,
        cloudSync: buildCloudSync(record)
      };

      setSelectedRecord(enrichedRecord);
      await saveRecord(enrichedRecord);
      await refreshLocalRecords();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "클라우드 상세 결과를 불러오지 못했습니다.");
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function handleDeleteLocalRecord(record: StoredExamRecord) {
    const shouldDeleteCloud = Boolean(record.cloudSync?.remoteId && authUser);
    const confirmed = window.confirm(
      shouldDeleteCloud
        ? "이 기록은 클라우드와 연결되어 있습니다. 로컬과 클라우드 기록을 함께 삭제할까요?"
        : "이 로컬 기록을 삭제할까요?"
    );

    if (!confirmed) {
      return;
    }

    await deleteRecord(record.id);

    if (shouldDeleteCloud) {
      const cloudRecord = cloudRecords.find((item) => item.id === record.cloudSync?.remoteId);

      if (cloudRecord && authUser) {
        await deleteCloudRecord(authUser.uid, cloudRecord);
      }
    }

    if (selectedRecord?.id === record.id) {
      setSelectedRecord(null);
      setSelectedCloudRecord(null);
    }

    await refreshLocalRecords();
  }

  async function handleDeleteCloudOnlyRecord(record: CloudExamRecord) {
    if (!authUser) {
      return;
    }

    const confirmed = window.confirm("이 클라우드 기록을 삭제할까요?");

    if (!confirmed) {
      return;
    }

    await deleteCloudRecord(authUser.uid, record);

    if (selectedCloudRecord?.id === record.id) {
      setSelectedCloudRecord(null);
      setSelectedRecord(null);
    }

  }

  async function handleManualOverride(selectionId: string, isCorrect: boolean) {
    if (!selectedRecord) {
      return;
    }

    const updatedResult = applyManualOverride(selectedRecord.result, selectionId, isCorrect);
    const syncedCloud = selectedRecord.cloudSync ?? (selectedCloudRecord ? buildCloudSync(selectedCloudRecord) : undefined);
    const updatedRecord: StoredExamRecord = {
      ...selectedRecord,
      result: updatedResult,
      cloudSync: syncedCloud
    };

    setSelectedRecord(updatedRecord);
    await saveRecord(updatedRecord);
    await refreshLocalRecords();

    if (authUser && syncedCloud) {
      await updateCloudRecordSummary(authUser.uid, updatedRecord, updatedResult);
    }
  }

  async function handleRequestAnalysis(selectionId: string) {
    if (!selectedRecord) {
      return;
    }

    const question = selectedRecord.result.questions.find((item) => item.selectionId === selectionId);
    const selection = selectedRecord.questionSelections.find((item) => item.id === selectionId);
    const answerPage = question?.matchedAnswerPageNumber
      ? selectedRecord.answerPages.find((item) => item.pageNumber === question.matchedAnswerPageNumber) ?? null
      : null;

    if (!question || !selection) {
      window.alert("분석할 문항 정보를 찾지 못했습니다.");
      return;
    }

    try {
      const pageQuestions = question?.matchedAnswerPageNumber
        ? selectedRecord.result.questions.filter((item) => item.matchedAnswerPageNumber === question.matchedAnswerPageNumber)
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
          metadata: selectedRecord.metadata,
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
      const syncedCloud = selectedRecord.cloudSync ?? (selectedCloudRecord ? buildCloudSync(selectedCloudRecord) : undefined);
      const updatedRecord: StoredExamRecord = {
        ...selectedRecord,
        result: {
          ...selectedRecord.result,
          questions: selectedRecord.result.questions.map((item) =>
            item.selectionId === selectionId
              ? {
                  ...item,
                  deepAnalysis: analysis
                }
              : item
          )
        },
        cloudSync: syncedCloud
      };

      setSelectedRecord(updatedRecord);
      await saveRecord(updatedRecord);
      await refreshLocalRecords();

      if (authUser && syncedCloud) {
        await updateCloudRecordSummary(authUser.uid, updatedRecord, updatedRecord.result);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "추가 분석 요청에 실패했습니다.");
    }
  }

  return (
    <main className="shell records-shell">
      <header className="records-topbar">
        <div className="topbar-brand">
          <div className="brand-dot" />
          <span>Grauto Records</span>
        </div>
        <div className="button-row">
          <Link className="cta ghost" href="/">
            채점 화면으로
          </Link>
        </div>
      </header>

      <section className="records-header-card">
        <h1>채점 기록</h1>
        <div className="button-row">
          <span className="status warn">로컬 {localRecords.length}</span>
          {authUser ? <span className="status ok">클라우드 {cloudRecords.length}</span> : null}
        </div>
      </section>

      <section className="records-section stack">
        <div className="record-sheet-list">
          {localRecords.map((record) => (
            <article className="record-sheet-card" key={`local-${record.id}`}>
              <div className="record-sheet-preview">
                {previewForLocalRecord(record) ? <img alt="기록 미리보기" src={previewForLocalRecord(record)} /> : <span>Preview</span>}
              </div>
              <div className="record-sheet-body">
                <div className="record-sheet-meta">
                  <h3>{record.metadata.examName || "이름 없는 시험"}</h3>
                  <span className="status warn">{record.metadata.difficulty}</span>
                </div>
                <p>{record.metadata.takenAt || "날짜 미입력"}</p>
                <p>{record.metadata.durationMinutes ? `${record.metadata.durationMinutes}분` : "소요 시간 미입력"}</p>
                <p>{record.metadata.subject}</p>
              </div>
              <div className="record-sheet-actions">
                <button type="button" className="cta" onClick={() => void handleViewLocalRecord(record)}>
                  결과 보기
                </button>
                <button type="button" className="cta ghost" onClick={() => void handleDeleteLocalRecord(record)}>
                  기록 삭제
                </button>
              </div>
            </article>
          ))}

          {cloudOnlyRecords.map((record) => (
            <article className="record-sheet-card" key={`cloud-${record.id}`}>
              <div className="record-sheet-preview">
                {record.previewImageDataUrl ? <img alt="클라우드 기록 미리보기" src={record.previewImageDataUrl} /> : <span>Cloud</span>}
              </div>
              <div className="record-sheet-body">
                <div className="record-sheet-meta">
                  <h3>{record.metadata.examName || "이름 없는 시험"}</h3>
                  <span className="status ok">{record.metadata.difficulty}</span>
                </div>
                <p>{record.metadata.takenAt || "날짜 미입력"}</p>
                <p>{record.metadata.durationMinutes ? `${record.metadata.durationMinutes}분` : "소요 시간 미입력"}</p>
                <p>{record.metadata.subject}</p>
              </div>
              <div className="record-sheet-actions">
                <button type="button" className="cta" onClick={() => void handleViewCloudRecord(record)} disabled={isLoadingDetail}>
                  {isLoadingDetail && selectedCloudRecord?.id === record.id ? "불러오는 중..." : "결과 보기"}
                </button>
                <button type="button" className="cta ghost" onClick={() => void handleDeleteCloudOnlyRecord(record)}>
                  기록 삭제
                </button>
              </div>
            </article>
          ))}

          {localRecords.length === 0 && cloudOnlyRecords.length === 0 ? (
            <div className="empty">저장된 채점 기록이 없습니다.</div>
          ) : null}
        </div>
      </section>

      {selectedRecord ? (
        <section className="records-detail-shell stack">
          <div className="card pad stack">
            <div className="selector-head">
              <div>
                <h2 className="section-title">{selectedRecord.metadata.examName || "선택한 채점 기록"}</h2>
              </div>
              <div className="button-row">
                <span className="status warn">정답 {selectedRecord.result.summary.correctCount}</span>
                <span className="status danger">오답 {selectedRecord.result.summary.incorrectCount}</span>
              </div>
            </div>
          </div>

          <ResultsDashboard
            result={selectedRecord.result}
            questionSelections={selectedRecord.questionSelections}
            answerPages={selectedRecord.answerPages}
            examName={selectedRecord.metadata.examName}
            onManualOverride={handleManualOverride}
            onRequestAnalysis={handleRequestAnalysis}
          />
        </section>
      ) : null}
    </main>
  );
}
