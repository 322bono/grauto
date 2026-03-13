"use client";

import { pdfjs } from "react-pdf";

let workerConfigured = false;

export function ensurePdfWorker() {
  if (workerConfigured) {
    return;
  }

  pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`;
  workerConfigured = true;
}
