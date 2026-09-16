// =========================
// classifyIntent Regression (Phase 20)
// =========================
//
// 対象: core/tact-intent/ruleRouter.ts の classifyIntent()。
// STEP216(Rule Router新設)・Phase18(疑問文/情報要求ルーティング)の
// 既存Reality Test結果をそのまま恒久testへ移した(絶対条件: LLM/API
// 呼び出み0件、classifyIntent()自体が決定論的なため)。
//
// Category A(Deterministic Evaluation)。

import {
  classifyIntent,
  getSimpleChatResponse,
} from "../../../core/tact-intent/ruleRouter";
import { check, summarize, type CheckResult } from "../lib/check";
import type { TactIntent } from "../../../core/tact-intent/types";

interface Case {
  phase: string;
  input: string;
  expected: TactIntent;
}

const cases: Case[] = [

  // STEP216: 元々のRule Router設計時からの既存ケース
  { phase: "STEP216", input: "日本の人口を調べて", expected: "research" },
  { phase: "STEP216", input: "日本の人口について調査して", expected: "research" },
  { phase: "STEP216", input: "日本の人口をリサーチして", expected: "research" },
  { phase: "STEP216", input: "このルールを覚えておいて", expected: "core_push" },
  { phase: "STEP216", input: "このコードを説明して", expected: "chat" },
  { phase: "STEP216", input: "今日は疲れた", expected: "chat" },
  { phase: "STEP216", input: "調べるってどういう意味?", expected: "chat" },
  { phase: "STEP216", input: "", expected: "chat" },

  // Phase18: 疑問文・情報要求ルーティング(Step9公式Reality Test A〜H)
  { phase: "Phase18-A", input: "日本の首相は誰ですか？", expected: "research" },
  { phase: "Phase18-B", input: "最新のiPhoneモデルは何ですか？", expected: "research" },
  { phase: "Phase18-C", input: "トヨタの競合はどこですか？", expected: "research" },
  { phase: "Phase18-D", input: "コードは何ですか？", expected: "chat" },
  { phase: "Phase18-E", input: "これはどういう意味ですか？", expected: "chat" },
  { phase: "Phase18-F", input: "調べるってどういう意味？", expected: "chat" },
  { phase: "Phase18-G", input: "日本の人口について教えて", expected: "research" },
  { phase: "Phase18-H", input: "これについてどう思う？", expected: "chat" },

  // Phase18: 追加FP検証で確認した既知の境界ケース
  { phase: "Phase18-FP", input: "これについてどう思いますか？", expected: "chat" },
  { phase: "Phase18-FP", input: "それは正しいですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "これはどうしたらいいですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "AIとは何ですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "おすすめを教えて", expected: "chat" },
  { phase: "Phase18-FP", input: "iPhoneの最新モデルについて知りたい", expected: "research" },

  // Phase82-C: 「具体例/実例/事例」+ 依頼表現 -> research
  // (Phase81 Root Cause: 外部世界に実在する対象物の列挙を求める依頼が
  // 「調べ/調査/リサーチ」を含まないためchatへ落ち、Research
  // Capability(実Web検索)を経由しない不具合の修正確認)
  { phase: "Phase82-J", input: "具体例を5件追加して", expected: "research" },
  { phase: "Phase82-J", input: "実際の事例を追加して", expected: "research" },
  { phase: "Phase82-J", input: "その分野の実例を教えて", expected: "research" },
  { phase: "Phase82-J", input: "代表的な事例を紹介して", expected: "research" },

  // Phase82-K: 生成依頼(action語尾が「作って」)はresearchを誤起動
  // しない(トピックに「具体例」を含んでいても、既存に実在する対象を
  // 求めるアクション語尾で無ければ対象外、Phase82絶対条件「False
  // Positiveを極力増やさない」)。
  { phase: "Phase82-K", input: "自分の文章から具体例を5つ作って", expected: "chat" },
  { phase: "Phase82-K", input: "適当な事例を考えて", expected: "chat" },

  // TIME-P1c Final Wiring: calendar_availability(空き時間確認、read
  // only)の狭い検出。Section18の完全な本番リクエストと、Section19
  // A/B/H(chat/write-disguised-as-readが誤ってcalendar_availabilityへ
  // 到達しないこと)を確認する。
  {
    phase: "TIME-P1c-18",
    input: "2026年9月17日、Asia/Tokyoで、10:00〜18:00の間から30分空いている時間を3つ探して。Google Calendarの予定を確認して。",
    expected: "calendar_availability",
  },
  { phase: "TIME-P1c-4", input: "空いている時間を探して", expected: "calendar_availability" },
  { phase: "TIME-P1c-4", input: "空き時間を探して", expected: "calendar_availability" },
  { phase: "TIME-P1c-4", input: "Google Calendarを確認して候補を出して", expected: "calendar_availability" },
  { phase: "TIME-P1c-4", input: "カレンダーを見て候補日時を探して", expected: "calendar_availability" },
  { phase: "TIME-P1c-4", input: "明日30分空いてるところ探して", expected: "calendar_availability" },
  // Section19-A: 定義質問はchatのまま(候補/空いている時間のいずれも
  // 含まないため、そもそもcalendar_availabilityへは一致しない)。
  { phase: "TIME-P1c-19A", input: "Google Calendarって何？", expected: "chat" },
  { phase: "TIME-P1c-19A", input: "カレンダーの使い方を教えて", expected: "chat" },
  // Section19-B/H: 書き込み依頼はcalendar_availabilityへ絶対に
  // 到達しない(disguised writeとしてread capabilityへ誤って
  // ルーティングされないことの確認)。
  { phase: "TIME-P1c-19B", input: "明日の予定をGoogle Calendarに入れて", expected: "chat" },
  { phase: "TIME-P1c-19H", input: "明日の予定を作って", expected: "chat" },
  { phase: "TIME-P1c-19H", input: "予定を削除して", expected: "chat" },
  // 「登録して」は既存のCORE_PUSH_PATTERN(覚え/記憶/保存/登録+依頼表現)
  // に一致する既存(TIME-P1c以前からの)挙動——このphaseはこれを変更
  // しない。ここで確認したいのはcalendar_availabilityへ誤って到達
  // しないことだけ(Section19-H絶対条件、Do NOT implement Calendar
  // write)。
  { phase: "TIME-P1c-19H", input: "会議を登録して", expected: "core_push" },

];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = cases.map((c) => {

    const decision = classifyIntent(c.input);

    return check(
      `[${c.phase}] classifyIntent("${c.input}") -> ${c.expected}`,
      decision.intent === c.expected,
      `actual=${decision.intent}, reason=${decision.reason}`
    );

  });

  const simpleChatCases: { input: string; expectedResponses?: readonly string[] }[] = [
    {
      input: "  こんにちは！！ ",
      expectedResponses: [
        "こんにちは！今日は何を進めますか？",
        "こんにちは！何か調べたいことはありますか？",
        "こんにちは！今日は何を任せますか？",
        "こんにちは！どうしましたか？",
      ],
    },
    {
      input: "ありがとう？",
      expectedResponses: [
        "どういたしまして！",
        "お役に立ててよかったです。",
        "こちらこそ、ありがとうございます。",
      ],
    },
    {
      input: "よろしく お願いします！",
      expectedResponses: [
        "こちらこそ、よろしくお願いします。何から始めましょうか？",
        "よろしくお願いします！今日は何を進めますか？",
      ],
    },
    {
      input: "おはよう！？",
      expectedResponses: [
        "おはようございます！今日は何から始めますか？",
        "おはようございます！今日もよろしくお願いします。",
      ],
    },
    { input: "こんにちは、今日の予定を教えて" },
  ];

  for (const c of simpleChatCases) {
    const response = getSimpleChatResponse(c.input);

    results.push(
      check(
        `[FastPath] getSimpleChatResponse(${JSON.stringify(c.input)})`,
        c.expectedResponses
          ? c.expectedResponses.includes(response ?? "")
          : response === undefined,
        `actual=${JSON.stringify(response)}`
      )
    );
  }

  return summarize("classifyIntent", results);

}
