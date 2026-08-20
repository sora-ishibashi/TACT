// =========================
// evidenceGuard (STEP20)
// =========================
//
// 背景:
// STEP19でResearcherのsystemPromptへ「検索していない情報を
// 推測で生成しない」という指示を追加したが、実機テストで、
// Researcherがweb-searchを一切実行していないにもかかわらず、
// 具体的な数値・統計・年次データ等を新規Evidenceとして
// 生成してしまうケースが再現された。
//
// 本モジュールは、Prompt遵守だけに依存しない機械的な安全網として、
// core/workflow/runAgent.tsの「Researcher Evidence 保存」処理から
// 呼び出される。対象は「今回のRunでResearcherが新たに生成した
// Evidence」のみであり、STEP18でcontext.evidenceへ事前投入される
// 過去Turnの既存Evidence(collectPastEvidence())はこの関数を
// 一切通らないため、影響を受けない。

// =========================
// hasSuccessfulToolResult
// =========================
//
// 今回のRunでResearcherが実際に(成功した)検索Toolを実行したかを
// 判定する。executeToolCalls()の戻り値(toolResults)をそのまま渡す。
// 失敗結果(success: false、Tavilyのクォータ超過エラー等)しか
// 存在しない場合は「検索実績なし」として扱う
// (実際にデータを取得できていないため)。

export function hasSuccessfulToolResult(
  toolResults: Record<string, unknown>
): boolean {

  return Object.values(toolResults).some((results) => {

    if (!Array.isArray(results)) return false;

    return results.some((entry) => {

      if (!entry || typeof entry !== "object") return false;

      const record = entry as Record<string, unknown>;

      if (record.success !== true) return false;

      // STEP80: web-search(executeToolPipeline)は、検索自体が
      // 成功しても該当件数0件の場合、success: true のまま
      // data.raw が空配列になる。success: true だけで
      // 「検索成功」と判定すると、0件検索がEvidence安全網
      // (rejectUnverifiedResearcherEvidence等)をすり抜けて
      // しまうため、data.rawを持つ形(=web-searchの結果形式)に
      // 限り、rawが1件以上ある場合のみ成功として扱う。
      // web-search以外の形(data.rawを持たない結果)は、
      // 従来どおりsuccess: trueのみで判定する(既存挙動を維持)。
      const data = record.data;

      if (
        data &&
        typeof data === "object" &&
        "raw" in (data as Record<string, unknown>)
      ) {

        const raw = (data as Record<string, unknown>).raw;

        return Array.isArray(raw) && raw.length > 0;

      }

      return true;

    });

  });

}

// =========================
// containsUnverifiedQuantitativeClaim
// =========================
//
// 「具体的な数値・統計」を含むEvidenceかどうかを判定する。
// 単に数字が含まれているだけでは判定しない
// (例:「スポーツイベントでは参加者数などの指標を分析する」の
// ような一般論を誤って除外しないため)。
// 数値と単位(%、円、台、件など)が組み合わさっているパターン、
// または年次と数値が近接して現れるパターンのみを対象とする。
//
// 判定が難しいケース(パターンに一致しない曖昧な記述)は
// 安全側(=既存動作どおり採用する)へfallbackする。

const QUANTITATIVE_CLAIM_PATTERNS: RegExp[] = [

  // パーセンテージ・割合
  /\d+(\.\d+)?\s*(%|％)/,

  // 金額
  /\d+(\.\d+)?\s*(万|億|兆)?\s*(円|ドル|USD)/,

  // 数量(台数・件数・人数・社数・店舗数等)
  /\d+(\.\d+)?\s*(万|億)?\s*(台|件|人|社|店舗)/,

  // 年次+近接する数値(例:「2026年...35万台」のような年次データ)
  /(19|20)\d{2}\s*年.{0,20}\d+(\.\d+)?/,

];

export function containsUnverifiedQuantitativeClaim(
  record: Record<string, unknown>
): boolean {

  const text = JSON.stringify(record);

  return QUANTITATIVE_CLAIM_PATTERNS.some((pattern) =>
    pattern.test(text)
  );

}
