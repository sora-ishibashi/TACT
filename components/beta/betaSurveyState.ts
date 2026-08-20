// =========================
// betaSurveyState (STEP30)
// =========================
//
// βテストアンケートの表示条件に使う、ブラウザ内(localStorage)だけの
// 状態管理。認証機構が未導入のため、ユーザーを跨いだ集計や
// サーバー側でのカウントは行わない
// (=このブラウザで実際に確認できた「独立した成果物」の数だけを扱う)。
//
// 「3つの独立した成果物」の定義:
// 同一conversationId内での部分更新・全体書き直しは、既にその
// conversationIdで1回でも成功した成果物生成が確認されていれば
// カウントしない。新しいconversationIdが初めて成功した成果物生成に
// 到達した時だけ1件とカウントする。Advisorのターン(workflowRunが
// null)やWorkflow失敗(resultイベント自体が届かない)は、そもそも
// このカウント処理が呼ばれないため対象外になる。

const COMPLETED_CONVERSATIONS_KEY =
  "tact_beta_completed_conversation_ids";

const SURVEY_DONE_KEY =
  "tact_beta_survey_done";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function loadCompletedConversationIds(): Set<string> {

  if (!isBrowser()) return new Set();

  try {

    const raw =
      window.localStorage.getItem(
        COMPLETED_CONVERSATIONS_KEY
      );

    if (!raw) return new Set();

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? new Set(
          parsed.filter(
            (id): id is string => typeof id === "string"
          )
        )
      : new Set();

  } catch {

    // 壊れた値が入っていた場合も、βアンケートの表示条件に
    // 影響するだけなので安全側(空)にfallbackする。
    return new Set();

  }

}

export function saveCompletedConversationIds(
  ids: Set<string>
): void {

  if (!isBrowser()) return;

  try {

    window.localStorage.setItem(
      COMPLETED_CONVERSATIONS_KEY,
      JSON.stringify(Array.from(ids))
    );

  } catch {
    // localStorageが使えない環境でも、アプリ本体の動作は止めない。
  }

}

export function loadSurveyDone(): boolean {

  if (!isBrowser()) return false;

  try {

    return (
      window.localStorage.getItem(SURVEY_DONE_KEY) === "1"
    );

  } catch {

    return false;

  }

}

export function saveSurveyDone(): void {

  if (!isBrowser()) return;

  try {

    window.localStorage.setItem(SURVEY_DONE_KEY, "1");

  } catch {
    // no-op
  }

}
