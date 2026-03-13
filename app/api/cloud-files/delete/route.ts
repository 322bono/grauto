import { NextResponse } from "next/server";
import { deleteRawAsset } from "@/lib/cloudinary/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      publicIds?: string[];
    };

    const publicIds = Array.isArray(body.publicIds) ? body.publicIds.filter((value): value is string => typeof value === "string") : [];

    await Promise.all(
      publicIds.map(async (publicId) => {
        try {
          await deleteRawAsset(publicId);
        } catch {
          return;
        }
      })
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "클라우드 파일 삭제에 실패했습니다.", {
      status: 500
    });
  }
}
