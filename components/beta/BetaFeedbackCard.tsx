"use client";

// =========================
// BetaFeedbackCard (STEP30)
// =========================
//
// 3つ目の独立した成果物生成が完了した直後に表示する、βテスト用の
// フィードバックアンケート。
//
// 重要: 画面全体を覆うbackdrop付きモーダルにはしない
// (「回答しなくてもTACTを継続利用できる」「アンケートを邪魔しない」
// という要件のため)。固定位置のカードとして表示し、チャット・
// 成果物の操作は裏で引き続き行える。

import { useState } from "react";

type Props = {
  conversationId: string | null;
  onClose: () => void;
  onSubmitted: () => void;
};

const USEFUL_PART_OPTIONS = [
  "成果物を作ってくれること",
  "AI Teamが仕事を分担していること",
  "調査・Evidenceが付いていること",
  "成果物を会話しながら修正できること",
  "成果物について質問できること",
  "変更箇所が分かること",
  "コピー・ダウンロードできること",
  "その他",
];

function RatingScale({
  value,
  onChange,
  lowLabel,
  highLabel,
}: {
  value: number | null;
  onChange: (value: number) => void;
  lowLabel: string;
  highLabel: string;
}) {

  return (

    <div>

      <div className="flex gap-2">

        {[1, 2, 3, 4, 5].map((n) => (

          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`
              h-9 w-9 rounded-full border text-sm font-medium transition
              ${
                value === n
                  ? "border-black bg-black text-white"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }
            `}
          >
            {n}
          </button>

        ))}

      </div>

      <div className="mt-1 flex justify-between text-[11px] text-gray-400">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>

    </div>

  );

}

export default function BetaFeedbackCard({
  conversationId,
  onClose,
  onSubmitted,
}: Props) {

  const [satisfaction, setSatisfaction] =
    useState<number | null>(null);

  const [usefulParts, setUsefulParts] =
    useState<string[]>([]);

  const [difficulties, setDifficulties] =
    useState("");

  const [willingnessToReuse, setWillingnessToReuse] =
    useState<number | null>(null);

  const [wantedFeatures, setWantedFeatures] =
    useState("");

  const [submitting, setSubmitting] =
    useState(false);

  const [submitted, setSubmitted] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  function toggleUsefulPart(part: string) {

    setUsefulParts((prev) =>
      prev.includes(part)
        ? prev.filter((p) => p !== part)
        : [...prev, part]
    );

  }

  async function handleSubmit() {

    if (satisfaction === null || willingnessToReuse === null) {

      setError(
        "質問1と質問4は選択してください。"
      );

      return;

    }

    setError(null);
    setSubmitting(true);

    try {

      const response = await fetch(
        "/api/tact/beta-feedback",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            satisfaction,
            usefulParts,
            difficulties,
            willingnessToReuse,
            wantedFeatures,
            conversationId: conversationId ?? undefined,
          }),
        }
      );

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error ?? "送信に失敗しました");
      }

      setSubmitted(true);

      // サンクスメッセージを少し見せてから閉じる。
      setTimeout(() => {
        onSubmitted();
      }, 2200);

    } catch (err) {

      console.error(err);

      setError(
        "送信に失敗しました。時間をおいて再度お試しください。"
      );

    } finally {

      setSubmitting(false);

    }

  }

  return (

    <div
      className="
        fixed
        bottom-6
        right-6
        z-50
        w-[380px]
        max-w-[calc(100vw-2rem)]
        max-h-[80vh]
        overflow-y-auto
        rounded-2xl
        border
        border-gray-200
        bg-white
        p-5
        shadow-2xl
      "
    >

      {submitted ? (

        <div className="py-4 text-center">

          <div className="mb-2 text-3xl">🙏</div>

          <p className="text-sm font-semibold text-gray-900">
            ありがとうございます！
          </p>

          <p className="mt-2 text-sm leading-6 text-gray-600">
            いただいたフィードバックはTACTの改善に活用します。
          </p>

        </div>

      ) : (

        <>

          <div className="mb-3 flex items-start justify-between gap-2">

            <div>

              <h3 className="text-sm font-semibold text-gray-900">
                ここまでTACTを使ってみて、どうでしたか？
              </h3>

              <p className="mt-1 text-xs leading-5 text-gray-500">
                βテストへのご協力ありがとうございます。
                1〜2分で回答できる簡単なアンケートです。
              </p>

            </div>

            <button
              onClick={onClose}
              aria-label="閉じる"
              className="shrink-0 text-gray-400 transition hover:text-gray-600"
            >
              ✕
            </button>

          </div>

          <div className="space-y-5">

            <div>

              <p className="mb-1.5 text-xs font-medium text-gray-800">
                1. TACTは、あなたがやりたかったことを簡単に進められましたか？
              </p>

              <RatingScale
                value={satisfaction}
                onChange={setSatisfaction}
                lowLabel="全くそう思わない"
                highLabel="とてもそう思う"
              />

            </div>

            <div>

              <p className="mb-1.5 text-xs font-medium text-gray-800">
                2. TACTのどの部分が一番役に立ちましたか？（複数選択可）
              </p>

              <div className="flex flex-wrap gap-1.5">

                {USEFUL_PART_OPTIONS.map((part) => (

                  <button
                    key={part}
                    type="button"
                    onClick={() => toggleUsefulPart(part)}
                    className={`
                      rounded-full border px-2.5 py-1 text-[11px] transition
                      ${
                        usefulParts.includes(part)
                          ? "border-black bg-black text-white"
                          : "border-gray-300 text-gray-600 hover:bg-gray-50"
                      }
                    `}
                  >
                    {part}
                  </button>

                ))}

              </div>

            </div>

            <div>

              <p className="mb-1.5 text-xs font-medium text-gray-800">
                3. TACTを使っていて、分かりにくかった・困ったことはありましたか？
              </p>

              <textarea
                value={difficulties}
                onChange={(e) => setDifficulties(e.target.value)}
                rows={2}
                placeholder="自由にご記入ください"
                className="
                  w-full
                  rounded-lg
                  border
                  border-gray-300
                  px-2.5
                  py-2
                  text-xs
                  outline-none
                  placeholder:text-gray-400
                  focus:border-gray-500
                "
              />

            </div>

            <div>

              <p className="mb-1.5 text-xs font-medium text-gray-800">
                4. 今後もTACTを使いたいと思いますか？
              </p>

              <RatingScale
                value={willingnessToReuse}
                onChange={setWillingnessToReuse}
                lowLabel="全く思わない"
                highLabel="ぜひ使いたい"
              />

            </div>

            <div>

              <p className="mb-1.5 text-xs font-medium text-gray-800">
                5. こうなったらもっと使いたい、と思う機能があれば教えてください。
              </p>

              <textarea
                value={wantedFeatures}
                onChange={(e) => setWantedFeatures(e.target.value)}
                rows={2}
                placeholder="自由にご記入ください"
                className="
                  w-full
                  rounded-lg
                  border
                  border-gray-300
                  px-2.5
                  py-2
                  text-xs
                  outline-none
                  placeholder:text-gray-400
                  focus:border-gray-500
                "
              />

            </div>

            {error && (
              <p className="text-xs text-red-500">{error}</p>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="
                w-full
                rounded-lg
                bg-black
                px-4
                py-2
                text-sm
                font-medium
                text-white
                transition
                hover:bg-gray-800
                disabled:opacity-50
              "
            >
              {submitting ? "送信中..." : "フィードバックを送る"}
            </button>

          </div>

        </>

      )}

    </div>

  );

}
