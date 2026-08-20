// =========================
// describeImage (STEP32)
// =========================
//
// ユーザーが添付した画像(PNG/JPG/JPEG/WEBP)の内容を、既存のLLM層
// (core/llm)を通じてOpenAIのVision機能で説明文にする、独立した
// 標準的な処理。core/conversation/reconstructTask.tsやcore/advisor/
// runAdvisor.tsと同じく、Workflow(runWorkflow/runAgent)には
// 一切参加しない。
//
// 得られた説明文は、他のファイル形式(PDF/Word/Excel/PowerPoint)の
// 抽出結果と同じ「テキスト」として扱われ、以降は同じ
// buildAttachmentEvidence()のパイプラインに合流する。

import { runLLM } from "../llm";

const IMAGE_DESCRIPTION_SYSTEM_PROMPT = `
あなたは画像の内容を客観的に説明するAIです。

画像に実際に写っている・書かれている内容だけを、事実として簡潔に
説明してください。

画像から確認できない情報を推測して補完してはいけません。

グラフや表がある場合は、読み取れる数値・ラベルを可能な限り
具体的に書き出してください。

文字(テキスト・数値)が書かれている場合は、読み取れる範囲で
そのまま書き出してください。

説明文はプレーンテキストで、簡潔に記述してください。
`.trim();

export async function describeImage(
  dataUrl: string,
  fileName: string
): Promise<string> {

  const response = await runLLM({

    provider: "openai",

    systemPrompt: IMAGE_DESCRIPTION_SYSTEM_PROMPT,

    userPrompt:
      `この画像(ファイル名: ${fileName})に何が写っているか、` +
      "書かれているかを説明してください。",

    responseFormat: "text",

    images: [{ dataUrl }],

  });

  const description = response.content?.trim();

  return description || "(画像の内容を読み取れませんでした)";

}
