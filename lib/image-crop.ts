"use client";

import { clampBoundingBox } from "@/lib/pdf-utils";
import type { NormalizedRect } from "@/lib/types";

export async function cropImageDataUrl(
  imageDataUrl: string,
  rect: NormalizedRect | null | undefined
): Promise<string | null> {
  const safeRect = clampBoundingBox(rect ?? null);

  if (!imageDataUrl || !safeRect) {
    return null;
  }

  const image = await loadImage(imageDataUrl);
  const cropX = Math.round(image.width * safeRect.x);
  const cropY = Math.round(image.height * safeRect.y);
  const cropWidth = Math.max(24, Math.round(image.width * safeRect.width));
  const cropHeight = Math.max(24, Math.round(image.height * safeRect.height));

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return canvas.toDataURL("image/png");
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("해설 이미지를 자르지 못했습니다."));
    image.src = source;
  });
}
