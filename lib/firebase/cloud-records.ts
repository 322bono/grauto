"use client";

import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc } from "firebase/firestore";
import { firebaseConfigured, firestore } from "@/lib/firebase/client";
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

interface SignedUploadResponse {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  publicId: string;
  params: {
    public_id: string;
    timestamp: number;
    overwrite: string;
    invalidate: string;
    use_filename: string;
    unique_filename: string;
    filename_override: string;
    tags: string;
    context: string;
  };
}

function requireFirestore() {
  if (!firebaseConfigured || !firestore) {
    throw new Error("Firebase 설정이 비어 있습니다.");
  }

  return firestore;
}

function isSameFile(left: File, right: File) {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

async function readTextError(response: Response, fallback: string) {
  const text = await response.text();
  return text.trim() || fallback;
}

async function requestSignedUpload(
  ownerUid: string,
  recordId: string,
  kind: "question" | "answer" | "detail",
  fileName: string
) {
  const response = await fetch("/api/cloud-files/sign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ownerUid,
      recordId,
      kind,
      fileName
    })
  });

  if (!response.ok) {
    throw new Error(await readTextError(response, "클라우드 업로드 서명을 만들지 못했습니다."));
  }

  return (await response.json()) as SignedUploadResponse;
}

async function uploadRawDirect(file: File | Blob, fileName: string, signed: SignedUploadResponse) {
  const formData = new FormData();
  formData.set("file", file, fileName);
  formData.set("api_key", signed.apiKey);
  formData.set("timestamp", String(signed.timestamp));
  formData.set("signature", signed.signature);
  formData.set("public_id", signed.params.public_id);
  formData.set("overwrite", signed.params.overwrite);
  formData.set("invalidate", signed.params.invalidate);
  formData.set("use_filename", signed.params.use_filename);
  formData.set("unique_filename", signed.params.unique_filename);
  formData.set("filename_override", signed.params.filename_override);
  formData.set("tags", signed.params.tags);
  formData.set("context", signed.params.context);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/raw/upload`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(await readTextError(response, "Cloudinary 업로드에 실패했습니다."));
  }

  const uploaded = (await response.json()) as {
    secure_url?: string;
    public_id?: string;
  };

  if (!uploaded.secure_url || !uploaded.public_id) {
    throw new Error("Cloudinary 업로드 결과가 비어 있습니다.");
  }

  return {
    url: uploaded.secure_url,
    publicId: uploaded.public_id
  };
}

async function uploadCloudAssets({
  ownerUid,
  record,
  questionFile,
  answerFile,
  onProgress
}: SyncExamRecordInput): Promise<CloudUploadResponse> {
  const reuseQuestionAsAnswer = record.uploadMode !== "split" && isSameFile(questionFile, answerFile);
  const recordJson = JSON.stringify({ ...record, cloudSync: undefined });

  onProgress?.(0.12, "업로드 준비 중");

  const questionUpload = await uploadRawDirect(
    questionFile,
    questionFile.name || "question.pdf",
    await requestSignedUpload(ownerUid, record.id, "question", questionFile.name || "question.pdf")
  );

  onProgress?.(0.4, "문제 PDF 업로드 완료");

  const answerUpload = reuseQuestionAsAnswer
    ? questionUpload
    : await uploadRawDirect(
        answerFile,
        answerFile.name || "answer.pdf",
        await requestSignedUpload(ownerUid, record.id, "answer", answerFile.name || "answer.pdf")
      );

  onProgress?.(0.68, "답안 PDF 업로드 완료");

  const detailUpload = await uploadRawDirect(
    new Blob([recordJson], { type: "application/json" }),
    "record.json",
    await requestSignedUpload(ownerUid, record.id, "detail", "record.json")
  );

  onProgress?.(0.9, "채점 결과 업로드 완료");

  return {
    questionPdfUrl: questionUpload.url,
    questionStoragePath: questionUpload.publicId,
    answerPdfUrl: answerUpload.url,
    answerStoragePath: answerUpload.publicId,
    detailJsonUrl: detailUpload.url,
    detailStoragePath: detailUpload.publicId
  };
}

async function uploadDetailJson(ownerUid: string, record: StoredExamRecord): Promise<DetailUploadResponse> {
  const detailUpload = await uploadRawDirect(
    new Blob([JSON.stringify({ ...record, cloudSync: undefined })], { type: "application/json" }),
    "record.json",
    await requestSignedUpload(ownerUid, record.id, "detail", "record.json")
  );

  return {
    detailJsonUrl: detailUpload.url,
    detailStoragePath: detailUpload.publicId
  };
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

  onProgress?.(0.96, "기록 저장 중");

  const db = requireFirestore();
  await setDoc(doc(db, "users", ownerUid, "examRecords", record.id), cloudRecord, {
    merge: true
  });

  onProgress?.(1, "클라우드 동기화 완료");
  return cloudRecord;
}

export async function updateCloudRecordSummary(ownerUid: string, record: StoredExamRecord, result: GradeResponsePayload) {
  const db = requireFirestore();
  const detailUpload = await uploadDetailJson(ownerUid, {
    ...record,
    result
  });

  await setDoc(
    doc(db, "users", ownerUid, "examRecords", record.id),
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
  const db = requireFirestore();
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

  await deleteDoc(doc(db, "users", ownerUid, "examRecords", record.id));
}

export function subscribeToCloudRecords(ownerUid: string, callback: (records: CloudExamRecord[]) => void) {
  if (!firebaseConfigured || !firestore) {
    callback([]);
    return () => undefined;
  }

  const collectionRef = collection(firestore, "users", ownerUid, "examRecords");
  const recordsQuery = query(collectionRef, orderBy("createdAt", "desc"));

  return onSnapshot(recordsQuery, (snapshot) => {
    callback(snapshot.docs.map((item) => item.data() as CloudExamRecord));
  });
}
