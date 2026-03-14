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

export async function cropImageDataUrlSegments(
  imageDataUrl: string,
  rects: Array<NormalizedRect | null | undefined>
): Promise<string | null> {
  const safeRects = rects
    .map((rect) => clampBoundingBox(rect ?? null))
    .filter((rect): rect is NormalizedRect => Boolean(rect));

  if (!imageDataUrl || safeRects.length === 0) {
    return null;
  }

  if (safeRects.length === 1) {
    return cropImageDataUrl(imageDataUrl, safeRects[0]);
  }

  const image = await loadImage(imageDataUrl);
  const gap = 18;
  const crops = safeRects.map((rect) => {
    const cropX = Math.round(image.width * rect.x);
    const cropY = Math.round(image.height * rect.y);
    const cropWidth = Math.max(24, Math.round(image.width * rect.width));
    const cropHeight = Math.max(24, Math.round(image.height * rect.height));

    return { cropX, cropY, cropWidth, cropHeight };
  });
  const targetWidth = Math.max(...crops.map((crop) => crop.cropWidth));
  const targetHeight = crops.reduce((sum, crop) => sum + crop.cropHeight, 0) + gap * (crops.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);

  let offsetY = 0;

  crops.forEach((crop) => {
    const offsetX = Math.max(0, Math.round((targetWidth - crop.cropWidth) / 2));
    context.drawImage(image, crop.cropX, crop.cropY, crop.cropWidth, crop.cropHeight, offsetX, offsetY, crop.cropWidth, crop.cropHeight);
    offsetY += crop.cropHeight + gap;
  });

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
