import { NextResponse } from "next/server";
import { uploadDetailJsonAsset } from "@/lib/cloudinary/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      ownerUid?: string;
      recordId?: string;
      recordJson?: string;
    };

    if (!body.ownerUid || !body.recordId || !body.recordJson) {
      return new NextResponse("상세 결과 업로드에 필요한 데이터가 부족합니다.", { status: 400 });
    }

    const detailUpload = await uploadDetailJsonAsset({
      ownerUid: body.ownerUid,
      recordId: body.recordId,
      recordJson: body.recordJson
    });

    return NextResponse.json({
      detailJsonUrl: detailUpload.url,
      detailStoragePath: detailUpload.publicId
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "상세 결과 업로드에 실패했습니다.", {
      status: 500
    });
  }
}
