"use client";

import { normalizeHeading } from "@/core/conversation/mergeWriterOutput";
import { parseContentBlocks } from "./parseContentBlocks";

type Props = {
  result: any;

  // STEP17: 直前のTurnから変更・追加された章の見出し一覧。
  // 一致する章に「蛍光ペン」風のハイライトを付ける最小実装。
  // 未指定/空の場合は従来どおり何もハイライトしない。
  changedHeadings?: string[];
};

// recommendations / nextActions は本来文字列のはずだが、
// Writerが {title, description} 形式のオブジェクトを返す場合があるため、
// どちらの形でもクラッシュせずに表示できるようにする。
function renderTextItem(item: unknown) {

  if (typeof item === "string") {
    return item;
  }

  if (item && typeof item === "object") {

    const obj = item as { title?: string; description?: string };

    if (obj.title || obj.description) {

      return (
        <>
          {obj.title && <strong>{obj.title}</strong>}
          {obj.title && obj.description ? "：" : ""}
          {obj.description}
        </>
      );

    }

  }

  return null;

}

// STEP31のMarkdown表検出ロジック(parseContentBlocks等)は、
// STEP41でcomponents/output/parseContentBlocks.tsへ抽出した
// (ロジック変更なし。PowerPoint Export側でも同じ検出結果を
// 再利用するため、importで読み込む形にしただけ)。

function renderSectionContent(content: string) {

  const blocks = parseContentBlocks(content);

  return blocks.map((block, index) => {

    if (block.type === "table" && block.headers) {

      return (

        <div
          key={index}
          className="overflow-x-auto"
        >

          <table className="w-full border-collapse text-sm">

            <thead>

              <tr>

                {block.headers.map((header, hIndex) => (

                  <th
                    key={hIndex}
                    className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold"
                  >
                    {header}
                  </th>

                ))}

              </tr>

            </thead>

            <tbody>

              {(block.rows ?? []).map((row, rIndex) => (

                <tr key={rIndex}>

                  {row.map((cell, cIndex) => (

                    <td
                      key={cIndex}
                      className="border border-gray-200 px-3 py-2 align-top"
                    >
                      {cell}
                    </td>

                  ))}

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      );

    }

    return (
      <p
        key={index}
        className="whitespace-pre-wrap leading-7"
      >
        {block.text}
      </p>
    );

  });

}

export default function FinalOutput({
  result,
  changedHeadings,
}: Props) {

  if (!result) return null;

  // STEP17: 章単位のハイライト判定用に正規化した見出し集合を作る。
  // セクション本文レベルの差分ではなく、変更・追加された章全体を
  // ハイライトする最小実装(ユーザー合意済みのミニマム構成)。
  const normalizedChanged = new Set(
    (changedHeadings ?? []).map(normalizeHeading)
  );

  return (

    <article className="mx-auto max-w-4xl space-y-8">

      <header>

        <h1 className="text-3xl font-bold">
          {result.title}
        </h1>

        {result.executiveSummary && (

          <p className="mt-4 leading-7 text-gray-700">
            {result.executiveSummary}
          </p>

        )}

      </header>

      {result.keyFindings?.length > 0 && (

        <section>

          <h2 className="mb-3 text-xl font-semibold">
            Key Findings
          </h2>

          <ul className="list-disc space-y-2 pl-6">

            {result.keyFindings.map(
              (item:any,index:number)=>(

                <li key={index}>
                  <strong>{item.title}</strong>

                  <p>{item.description ?? item.summary}</p>
                </li>

              )
            )}

          </ul>

        </section>

      )}

      {result.sections?.map(
        (section:any,index:number)=>{

          const isChanged =
            typeof section.heading === "string" &&
            normalizedChanged.has(
              normalizeHeading(section.heading)
            );

          return (

          <section
            key={index}
            className={
              "space-y-3" +
              (isChanged
                ? " -mx-3 rounded-lg border-l-4 border-yellow-400 bg-yellow-50 px-3 py-2"
                : "")
            }
          >

            {isChanged && (

              <span
                className="
                  inline-block
                  rounded-full
                  bg-yellow-200
                  px-2
                  py-0.5
                  text-[10px]
                  font-semibold
                  uppercase
                  tracking-wide
                  text-yellow-800
                "
              >
                今回更新
              </span>

            )}

            <h2 className="text-2xl font-bold">
              {section.title ?? section.heading}
            </h2>

            {section.content && (

              <div className="space-y-3">
                {renderSectionContent(section.content)}
              </div>

            )}

            {section.points?.length > 0 && (

              <ul className="list-disc pl-6 space-y-2">

                {section.points.map(
                  (
                    point:string,
                    i:number
                  )=>(

                    <li key={i}>
                      {point}
                    </li>

                  )
                )}

              </ul>

            )}

          </section>

          );

        }
      )}

      {result.recommendations?.length > 0 && (

        <section>

          <h2 className="text-xl font-semibold mb-3">
            Recommendations
          </h2>

          <ul className="list-disc pl-6 space-y-2">

            {result.recommendations.map(
              (
                item:unknown,
                index:number
              )=>(

                <li key={index}>
                  {renderTextItem(item)}
                </li>

              )
            )}

          </ul>

        </section>

      )}

      {result.nextActions?.length > 0 && (

        <section>

          <h2 className="text-xl font-semibold mb-3">
            Next Actions
          </h2>

          <ol className="list-decimal pl-6 space-y-2">

            {result.nextActions.map(
              (
                item:unknown,
                index:number
              )=>(

                <li key={index}>
                  {renderTextItem(item)}
                </li>

              )
            )}

          </ol>

        </section>

      )}

    </article>

  );

}