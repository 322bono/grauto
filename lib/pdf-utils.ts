"use client";

import { pdfjs } from "react-pdf";
import { ensurePdfWorker } from "@/lib/pdf-worker";
import type { NormalizedRect } from "@/lib/types";

ensurePdfWorker();

export function clonePdfBytes(source: Uint8Array) {
  return new Uint8Array(source.slice());
}

function toPdfData(source: File | ArrayBuffer | Uint8Array) {
  if (source instanceof Uint8Array) {
    return clonePdfBytes(source);
  }

  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(0));
  }

  return source.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export async function extractPdfTextSnippets(source: File | ArrayBuffer | Uint8Array) {
  const data = await toPdfData(source);
  const document = await pdfjs.getDocument({ data }).promise;
  const snippets: Record<number, string> = {};

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    snippets[pageNumber] = text.slice(0, 180);
  }

  return snippets;
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number, width: number, height: number) {
  const left = Math.max(0, Math.min(startX, endX));
  const top = Math.max(0, Math.min(startY, endY));
  const right = Math.min(width, Math.max(startX, endX));
  const bottom = Math.min(height, Math.max(startY, endY));

  return {
    x: left / width,
    y: top / height,
    width: Math.max(0, right - left) / width,
    height: Math.max(0, bottom - top) / height
  };
}

export function denormalizeRect(rect: NormalizedRect, width: number, height: number) {
  return {
    left: rect.x * width,
    top: rect.y * height,
    width: rect.width * width,
    height: rect.height * height
  };
}

export function cropCanvasToDataUrl(sourceCanvas: HTMLCanvasElement, rect: NormalizedRect) {
  const actual = denormalizeRect(rect, sourceCanvas.width, sourceCanvas.height);
  const cropX = Math.max(0, actual.left);
  const cropY = Math.max(0, actual.top);
  const cropWidth = Math.max(16, actual.width);
  const cropHeight = Math.max(16, actual.height);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropWidth);
  canvas.height = Math.round(cropHeight);
  const context = canvas.getContext("2d");

  if (!context) {
    return "";
  }

  context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function canvasToCompressedDataUrl(
  sourceCanvas: HTMLCanvasElement,
  options?: {
    maxWidth?: number;
    mimeType?: "image/jpeg" | "image/png";
    quality?: number;
  }
) {
  const maxWidth = options?.maxWidth ?? sourceCanvas.width;
  const mimeType = options?.mimeType ?? "image/jpeg";
  const quality = options?.quality ?? 0.74;
  const scale = Math.min(1, maxWidth / Math.max(1, sourceCanvas.width));
  const targetWidth = Math.max(24, Math.round(sourceCanvas.width * scale));
  const targetHeight = Math.max(24, Math.round(sourceCanvas.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return "";
  }

  context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, targetWidth, targetHeight);
  return mimeType === "image/png" ? canvas.toDataURL(mimeType) : canvas.toDataURL(mimeType, quality);
}

export function renderCropStyle(rect: NormalizedRect) {
  return {
    img: {
      width: `${100 / rect.width}%`,
      height: `${100 / rect.height}%`,
      transform: `translate(${-rect.x * 100}%, ${-rect.y * 100}%)`,
      transformOrigin: "top left"
    }
  } as const;
}

export function clampBoundingBox(box: NormalizedRect | null): NormalizedRect | null {
  if (!box) {
    return null;
  }

  const x = Math.min(0.96, Math.max(0, box.x));
  const y = Math.min(0.96, Math.max(0, box.y));
  const width = Math.min(1 - x, Math.max(0.04, box.width));
  const height = Math.min(1 - y, Math.max(0.04, box.height));

  return { x, y, width, height };
}
