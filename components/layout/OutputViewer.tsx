"use client";

import { useRef, useState } from "react";

import FinalOutput from "../output/FinalOutput";
import {
  buildOutputMarkdown,
  buildOutputFilename,
} from "../output/formatOutputText";
import {
  buildOutputPptx,
  buildOutputPptxFilename,
} from "../output/buildOutputPptx";

type Props = {
  result: any;
  runStatus: "idle" | "running" | "completed" | "error";

  // STEP17: 変更箇所ハイライト対象の章見出し一覧。
  changedHeadings?: string[];
};

// STEP23: 「コピーしました」表示を残す時間(ms)。
const COPIED_DISPLAY_MS = 2000;

export default function OutputViewer({
  result,
  runStatus,
  changedHeadings,
}: Props) {

  // STEP23: コピー操作の直後だけ「コピーしました」を表示するための、
  // 表示専用の一時state。他の状態(runStatus等)とは独立して扱う。
  const [copied, setCopied] =
    useState(false);

  const copiedTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  // STEP41: PPTX生成は非同期(pptxgenjs)のため、生成中の二重クリックを
  // 防ぐためだけの最小限のstate。既存のcopied/runStatus等とは独立。
  const [pptxLoading, setPptxLoading] =
    useState(false);

  function handleCopy() {

    const text = buildOutputMarkdown(result);

    if (!text.trim()) return;

    navigator.clipboard
      .writeText(text)
      .then(() => {

        if (copiedTimerRef.current) {
          clearTimeout(copiedTimerRef.current);
        }

        setCopied(true);

        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, COPIED_DISPLAY_MS);

      })
      .catch((error) => {
        console.error("Failed to copy output:", error);
      });

  }

  function handleDownload() {

    const text = buildOutputMarkdown(result);

    if (!text.trim()) return;

    const blob = new Blob(
      [text],
      { type: "text/markdown;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = buildOutputFilename(result);

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);

  }

  // STEP41: 成果物を編集可能なPowerPoint(.pptx)として書き出す。
  // 生成自体はブラウザ内(pptxgenjs)で完結し、既存の.mdダウンロードと
  // 同じ「Blobを作ってaタグ経由でダウンロードする」パターンを再利用する。
  async function handleDownloadPptx() {

    if (pptxLoading) return;

    setPptxLoading(true);

    try {

      const blob = await buildOutputPptx(result);

      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");

      link.href = url;
      link.download = buildOutputPptxFilename(result);

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);

    } catch (error) {

      console.error("Failed to generate PPTX:", error);

    } finally {

      setPptxLoading(false);

    }

  }

  return (

    <div
      className="
        flex
        h-full
        flex-col
        overflow-hidden
        rounded-xl
        border
        border-gray-200
        bg-white
      "
    >

      {/* Header */}

      <div
        className="
          flex
          shrink-0
          items-start
          justify-between
          gap-3
          border-b
          border-gray-200
          px-4
          py-3
        "
      >

        <div>

          <p
            className="
              text-[10px]
              font-semibold
              uppercase
              tracking-widest
              text-blue-600
            "
          >
            OUTPUT
          </p>


          <h2
            className="
              mt-1
              text-base
              font-semibold
              text-gray-900
            "
          >
            成果物
          </h2>

        </div>

        {/*
          STEP23: 生成された成果物をそのまま持ち出せるようにする
          最小限の操作。resultが存在する場合のみ表示する。
          コピー/ダウンロードのいずれも、画面表示中のresult
          (=Writerの生出力ではなく、reconcileCurrentOutput()を
          経た最終的なcurrentOutput)をそのままMarkdown化する。
        */}

        {result && (

          <div className="flex shrink-0 items-center gap-2">

            <button
              onClick={handleCopy}
              className="
                rounded-lg
                border
                border-gray-200
                bg-white
                px-3
                py-1.5
                text-xs
                font-medium
                text-gray-700
                transition
                hover:bg-gray-50
              "
            >
              {copied ? "コピーしました" : "コピー"}
            </button>

            <button
              onClick={handleDownload}
              className="
                rounded-lg
                border
                border-gray-200
                bg-white
                px-3
                py-1.5
                text-xs
                font-medium
                text-gray-700
                transition
                hover:bg-gray-50
              "
            >
              .mdでダウンロード
            </button>

            <button
              onClick={handleDownloadPptx}
              disabled={pptxLoading}
              className="
                rounded-lg
                border
                border-gray-200
                bg-white
                px-3
                py-1.5
                text-xs
                font-medium
                text-gray-700
                transition
                hover:bg-gray-50
                disabled:opacity-50
              "
            >
              {pptxLoading ? "生成中..." : ".pptxでダウンロード"}
            </button>

          </div>

        )}

      </div>



      {/* Content */}

      <div className="min-h-0 flex-1 overflow-y-auto">

        {result ? (

          <div className="px-5 py-4">

            <FinalOutput
              result={result}
              changedHeadings={changedHeadings}
            />

          </div>

        ) : (

          <div
            className="
              flex
              h-full
              items-center
              justify-center
              px-6
            "
          >

            <div className="max-w-xs text-center">

              <div className="mb-3 text-4xl">
                📄
              </div>


              <h3
                className="
                  text-base
                  font-semibold
                  text-gray-900
                "
              >
                {runStatus === "running"
                  ? "成果物を生成中"
                  : runStatus === "error"
                  ? "成果物を生成できませんでした"
                  : "成果物はまだありません"}
              </h3>


              <p
                className="
                  mt-2
                  text-sm
                  leading-6
                  text-gray-500
                "
              >
                {runStatus === "running"
                  ? "AIチームが調査・設計・レビューを行っています。"
                  : runStatus === "error"
                  ? "処理中にエラーが発生しました。もう一度お試しください。"
                  : "チャットから依頼を送ると、完成した成果物をここに表示します。"}
              </p>

            </div>

          </div>

        )}

      </div>


    </div>

  );

}