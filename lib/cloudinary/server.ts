import "server-only";

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { Readable } from "node:stream";

let configured = false;

function isClearlyInvalidCloudName(value: string) {
  return value.toLowerCase() === "root" || /\s/.test(value) || value.includes("/") || value.includes("\\") || value.startsWith("http");
}

function ensureCloudinary() {
  if (configured) {
    return cloudinary;
  }

  const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (cloudinaryUrl) {
    cloudinary.config(cloudinaryUrl);

    const configuredCloudName = String(cloudinary.config().cloud_name ?? "").trim();

    if (!configuredCloudName || isClearlyInvalidCloudName(configuredCloudName)) {
      throw new Error(
        "Cloudinary 설정이 잘못되었습니다. CLOUDINARY_URL에는 cloudinary://API_KEY:API_SECRET@CLOUD_NAME 형식만 넣어 주세요."
      );
    }

    configured = true;
    return cloudinary;
  }

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary 환경 변수가 비어 있습니다. CLOUDINARY_URL 또는 CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET를 설정해 주세요."
    );
  }

  if (isClearlyInvalidCloudName(cloudName)) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME 값이 잘못되었습니다. 'Root' 같은 폴더명이 아니라 Cloudinary Dashboard에 보이는 실제 Cloud name만 넣어 주세요."
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });

  configured = true;
  return cloudinary;
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toPublicId(ownerUid: string, recordId: string, kind: "question" | "answer" | "detail", fileName: string) {
  const safeName = sanitizeFileName(fileName);
  return `grauto/users/${ownerUid}/exam-records/${recordId}/${kind}-${safeName}`;
}

function uploadBuffer(
  buffer: Buffer,
  options: {
    ownerUid: string;
    recordId: string;
    kind: "question" | "answer" | "detail";
    fileName: string;
  }
) {
  const client = ensureCloudinary();
  const publicId = toPublicId(options.ownerUid, options.recordId, options.kind, options.fileName);

  return new Promise<UploadApiResponse>((resolve, reject) => {
    const uploadStream = client.uploader.upload_stream(
      {
        resource_type: "raw",
        public_id: publicId,
        overwrite: true,
        invalidate: true,
        use_filename: false,
        unique_filename: false,
        filename_override: options.fileName,
        folder: undefined,
        tags: ["grauto", options.kind],
        context: {
          owner_uid: options.ownerUid,
          record_id: options.recordId
        }
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary 업로드 결과가 비어 있습니다."));
          return;
        }

        resolve(result);
      }
    );

    Readable.from(buffer).pipe(uploadStream);
  });
}

export async function uploadPdfAsset(input: {
  ownerUid: string;
  recordId: string;
  kind: "question" | "answer";
  file: File;
}) {
  const buffer = Buffer.from(await input.file.arrayBuffer());
  const result = await uploadBuffer(buffer, {
    ownerUid: input.ownerUid,
    recordId: input.recordId,
    kind: input.kind,
    fileName: input.file.name || `${input.kind}.pdf`
  });

  return {
    url: result.secure_url,
    publicId: result.public_id
  };
}

export async function uploadDetailJsonAsset(input: {
  ownerUid: string;
  recordId: string;
  recordJson: string;
}) {
  const buffer = Buffer.from(input.recordJson, "utf-8");
  const result = await uploadBuffer(buffer, {
    ownerUid: input.ownerUid,
    recordId: input.recordId,
    kind: "detail",
    fileName: "record.json"
  });

  return {
    url: result.secure_url,
    publicId: result.public_id
  };
}

export async function deleteRawAsset(publicId: string) {
  const client = ensureCloudinary();
  const result = await client.uploader.destroy(publicId, {
    resource_type: "raw",
    invalidate: true
  });

  return result;
}

export function buildSignedRawUpload(input: {
  ownerUid: string;
  recordId: string;
  kind: "question" | "answer" | "detail";
  fileName: string;
}) {
  const client = ensureCloudinary();
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = toPublicId(input.ownerUid, input.recordId, input.kind, input.fileName);
  const params = {
    public_id: publicId,
    timestamp,
    overwrite: "true",
    invalidate: "true",
    use_filename: "false",
    unique_filename: "false",
    filename_override: input.fileName,
    tags: `grauto,${input.kind}`,
    context: `owner_uid=${input.ownerUid}|record_id=${input.recordId}`
  };

  return {
    cloudName: client.config().cloud_name as string,
    apiKey: client.config().api_key as string,
    timestamp,
    signature: cloudinary.utils.api_sign_request(params, client.config().api_secret as string),
    publicId,
    params
  };
}
