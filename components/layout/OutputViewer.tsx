"use client";

import FinalOutput from "../output/FinalOutput";

type Props = {
  result: any;
};

export default function OutputViewer({
  result,
}: Props) {

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
          shrink-0
          border-b
          border-gray-200
          px-4
          py-3
        "
      >

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



      {/* Content */}

      <div className="min-h-0 flex-1 overflow-y-auto">

        {result ? (

          <div className="px-5 py-4">

            <FinalOutput
              result={result}
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
                成果物を生成中
              </h3>


              <p
                className="
                  mt-2
                  text-sm
                  leading-6
                  text-gray-500
                "
              >
                AIチームが調査・設計・レビューを行い、
                完成した成果物をここに表示します。
              </p>

            </div>

          </div>

        )}

      </div>


    </div>

  );

}