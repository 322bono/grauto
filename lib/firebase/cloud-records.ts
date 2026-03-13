"use client";

import { deleteDoc, collection, doc, onSnapshot, orderBy, query, setDoc } from "firebase/firestore";
import { firestore } from "@/lib/firebase/client";
import type { CloudExamRecord, GradeResponsePayload, StoredExamRecord } from "@/lib/types";

interface SyncExamRecordInput {
  ownerUid: string;
  record: StoredExamRecord;
  questionFile: File;
  answerFile: File;
  onProgress?: (progress: number, stage: string) => void;
}

interface CloudUploadResponse {
  questionPdfUrl: string;
  questionStoragePath: string;
  answerPdfUrl: string;
  answerStoragePath: string;
  detailJsonUrl: string;
  detailStoragePath: string;
}

interface DetailUploadResponse {
  detailJsonUrl: string;
  detailStoragePath: string;
}

function isSameFile(left: File, right: File) {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

async function readTextError(response: Response, fallback: string) {
  const text = await response.text();
  return text.trim() || fallback;
}

async function uploadCloudAssets({
  ownerUid,
  record,
  questionFile,
  answerFile,
  onProgress
}: SyncExamRecordInput): Promise<CloudUploadResponse> {
  const formData = new FormData();
  const reuseQuestionAsAnswer = record.uploadMode !== "split" && isSameFile(questionFile, answerFile);

  formData.set("ownerUid", ownerUid);
  formData.set("recordId", record.id);
  formData.set("recordJson", JSON.stringify({ ...record, cloudSync: undefined }));
  formData.set("reuseQuestionAsAnswer", String(reuseQuestionAsAnswer));
  formData.set("questionFile", questionFile, questionFile.name);

  if (!reuseQuestionAsAnswer) {
    formData.set("answerFile", answerFile, answerFile.name);
  }

  onProgress?.(0.12, "클라우드 업로드 준비 중");

  const response = await fetch("/api/cloud-files/sync", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(await readTextError(response, "클라우드 업로드에 실패했습니다."));
  }

  onProgress?.(0.78, "파일 업로드 완료");
  return (await response.json()) as CloudUploadResponse;
}

async function uploadDetailJson(ownerUid: string, record: StoredExamRecord): Promise<DetailUploadResponse> {
  const response = await fetch("/api/cloud-files/detail", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ownerUid,
      recordId: record.id,
      recordJson: JSON.stringify({ ...record, cloudSync: undefined })
    })
  });

  if (!response.ok) {
    throw new Error(await readTextError(response, "상세 결과 업로드에 실패했습니다."));
  }

  return (await response.json()) as DetailUploadResponse;
}

export async function syncExamRecordToCloud({
  ownerUid,
  record,
  questionFile,
  answerFile,
  onProgress
}: SyncExamRecordInput): Promise<CloudExamRecord> {
  const upload = await uploadCloudAssets({
    ownerUid,
    record,
    questionFile,
    answerFile,
    onProgress
  });

  const cloudRecord: CloudExamRecord = {
    id: record.id,
    ownerUid,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
    uploadMode: record.uploadMode,
    metadata: record.metadata,
    questionFileName: questionFile.name,
    answerFileName: answerFile.name,
    previewImageDataUrl: record.questionSelections[0]?.snapshotDataUrl ?? record.answerPages[0]?.pageImageDataUrl,
    questionPdfUrl: upload.questionPdfUrl,
    questionStoragePath: upload.questionStoragePath,
    answerPdfUrl: upload.answerPdfUrl,
    answerStoragePath: upload.answerStoragePath,
    detailJsonUrl: upload.detailJsonUrl,
    detailStoragePath: upload.detailStoragePath,
    resultSummary: record.result.summary,
    resultMode: record.result.mode
  };

  onProgress?.(0.9, "기록 메타데이터 저장 중");

  await setDoc(doc(firestore, "users", ownerUid, "examRecords", record.id), cloudRecord, {
    merge: true
  });

  onProgress?.(1, "클라우드 동기화 완료");
  return cloudRecord;
}

export async function updateCloudRecordSummary(ownerUid: string, record: StoredExamRecord, result: GradeResponsePayload) {
  const detailUpload = await uploadDetailJson(ownerUid, {
    ...record,
    result
  });

  await setDoc(
    doc(firestore, "users", ownerUid, "examRecords", record.id),
    {
      updatedAt: new Date().toISOString(),
      detailJsonUrl: detailUpload.detailJsonUrl,
      detailStoragePath: detailUpload.detailStoragePath,
      resultSummary: result.summary,
      resultMode: result.mode
    },
    { merge: true }
  );
}

export async function fetchCloudRecordDetail(detailJsonUrl: string): Promise<StoredExamRecord> {
  const response = await fetch(detailJsonUrl);

  if (!response.ok) {
    throw new Error("클라우드 상세 결과를 불러오지 못했습니다.");
  }

  return (await response.json()) as StoredExamRecord;
}

export async function deleteCloudRecord(ownerUid: string, record: CloudExamRecord) {
  const publicIds = [record.questionStoragePath, record.answerStoragePath, record.detailStoragePath].filter(
    (value): value is string => Boolean(value)
  );

  if (publicIds.length > 0) {
    await fetch("/api/cloud-files/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publicIds })
    });
  }

  await deleteDoc(doc(firestore, "users", ownerUid, "examRecords", record.id));
}

export function subscribeToCloudRecords(ownerUid: string, callback: (records: CloudExamRecord[]) => void) {
  const collectionRef = collection(firestore, "users", ownerUid, "examRecords");
  const recordsQuery = query(collectionRef, orderBy("createdAt", "desc"));

  return onSnapshot(recordsQuery, (snapshot) => {
    callback(snapshot.docs.map((item) => item.data() as CloudExamRecord));
  });
}
