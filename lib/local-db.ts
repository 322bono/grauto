"use client";

import Dexie, { type Table } from "dexie";
import type { StoredExamRecord } from "@/lib/types";

class AutoGraderDB extends Dexie {
  records!: Table<StoredExamRecord, string>;

  constructor() {
    super("auto-grader-local-db");
    this.version(1).stores({
      records: "id, createdAt, metadata.subject, metadata.examName"
    });
  }
}

const db = new AutoGraderDB();

export async function saveRecord(record: StoredExamRecord) {
  await db.records.put(record);
}

export async function listRecords() {
  return db.records.orderBy("createdAt").reverse().toArray();
}

export async function getRecord(recordId: string) {
  return db.records.get(recordId);
}

export async function deleteRecord(recordId: string) {
  await db.records.delete(recordId);
}
