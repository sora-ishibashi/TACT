import { NextRequest, NextResponse } from "next/server";

import {
  extractTextFromFile,
  isSupportedFile,
  isImageFile,
} from "@/core/fileAnalysis/extractFileContent";

import { describeImage } from "@/core/fileAnalysis/describeImage";

// =========================
// POST /api/tact/attachments (STEP32)
// =========================
//
// チャットに添付された1ファイルを受け取り、テキストを抽出して
// 返すだけの、独立したエンドポイント。
//
// 重要:
// - ファイル本体はここで解析に使うだけで、保存(DB/Storage)はしない。
//   抽出済みテキストだけをレスポンスとして返す。
// - 既存の /api/tact/conversation, /api/tact/conversation/stream の
//   実装・契約には一切触れない。
//
// body: multipart/form-data、フィールド名 "file"
//
// response:
// { success: true, fileName, mimeType, extractedText }
// { success: false, error }

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

export async function POST(
  request: NextRequest
) {

  try {

    const formData = await request.formData();

    const file = formData.get("file");

    if (!file || !(file instanceof File)) {

      return NextResponse.json(
        {
          success: false,
          error: "ファイルが指定されていません",
        },
        { status: 400 }
      );

    }

    if (file.size === 0) {

      return NextResponse.json(
        {
          success: false,
          error: "空のファイルです",
        },
        { status: 400 }
      );

    }

    if (file.size > MAX_FILE_SIZE_BYTES) {

      return NextResponse.json(
        {
          success: false,
          error: `ファイルサイズが上限(${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)を超えています`,
        },
        { status: 400 }
      );

    }

    if (!isSupportedFile(file.name)) {

      return NextResponse.json(
        {
          success: false,
          error:
            "対応していないファイル形式です" +
            "(PDF / DOCX / XLSX / PPTX / PNG / JPG / JPEG / WEBPのみ対応)",
        },
        { status: 400 }
      );

    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText: string;

    if (isImageFile(file.name)) {

      const base64 = buffer.toString("base64");

      const dataUrl =
        `data:${file.type || "image/png"};base64,${base64}`;

      extractedText =
        await describeImage(dataUrl, file.name);

    } else {

      const result =
        await extractTextFromFile(file.name, buffer);

      if (!result.success) {

        return NextResponse.json(
          {
            success: false,
            error: result.error,
          },
          { status: 422 }
        );

      }

      extractedText = result.text ?? "";

    }

    return NextResponse.json({

      success: true,

      fileName: file.name,

      mimeType: file.type || "application/octet-stream",

      extractedText,

    });

  } catch (error) {

    console.error(
      "Attachment processing failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: String(error),
      },
      { status: 500 }
    );

  }

}
