import { NextResponse } from "next/server";
import { uploadDetailJsonAsset, uploadPdfAsset } from "@/lib/cloudinary/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const ownerUid = toStringValue(formData.get("ownerUid"));
    const recordId = toStringValue(formData.get("recordId"));
    const recordJson = toStringValue(formData.get("recordJson"));
    const reuseQuestionAsAnswer = toStringValue(formData.get("reuseQuestionAsAnswer")) === "true";
    const questionFile = formData.get("questionFile");
    const answerFile = formData.get("answerFile");

    if (!ownerUid || !recordId || !recordJson || !(questionFile instanceof File)) {
      return new NextResponse("업로드 요청에 필요한 데이터가 부족합니다.", { status: 400 });
    }

    const questionUpload = await uploadPdfAsset({
      ownerUid,
      recordId,
      kind: "question",
      file: questionFile
    });

    const answerUpload =
      reuseQuestionAsAnswer || !(answerFile instanceof File)
        ? {
            url: questionUpload.url,
            publicId: questionUpload.publicId
          }
        : await uploadPdfAsset({
            ownerUid,
            recordId,
            kind: "answer",
            file: answerFile
          });

    const detailUpload = await uploadDetailJsonAsset({
      ownerUid,
      recordId,
      recordJson
    });

    return NextResponse.json({
      questionPdfUrl: questionUpload.url,
      questionStoragePath: questionUpload.publicId,
      answerPdfUrl: answerUpload.url,
      answerStoragePath: answerUpload.publicId,
      detailJsonUrl: detailUpload.url,
      detailStoragePath: detailUpload.publicId
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "클라우드 업로드에 실패했습니다.", {
      status: 500
    });
  }
}

function toStringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}
