import { NextResponse } from "next/server";
import { buildSignedRawUpload } from "@/lib/cloudinary/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      ownerUid?: string;
      recordId?: string;
      kind?: "question" | "answer" | "detail";
      fileName?: string;
    };

    if (!body.ownerUid || !body.recordId || !body.kind || !body.fileName) {
      return new NextResponse("업로드 서명에 필요한 값이 부족합니다.", { status: 400 });
    }

    return NextResponse.json(buildSignedRawUpload({
      ownerUid: body.ownerUid,
      recordId: body.recordId,
      kind: body.kind,
      fileName: body.fileName
    }));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "업로드 서명을 만들지 못했습니다.", {
      status: 500
    });
  }
}
