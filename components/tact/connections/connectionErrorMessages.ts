// =========================
// connectionErrorMessages (PRODUCT-P1: Connection UX)
// =========================
//
// Connections画面がユーザーへ表示する固定文言。raw provider error・
// OAuth token・Connected Account ID・provider metadataはこのfile・
// 呼び出し元のいずれにも一切表示しない(絶対条件、Error UX)。

export type ConnectionActionErrorKind =
  | "oauth_cancelled"
  | "provider_failed"
  | "multiple_active"
  | "confirm_timeout"
  | "generic";

export function describeConnectionActionError(
  kind: ConnectionActionErrorKind
): string {

  switch (kind) {

    case "oauth_cancelled":
      return "接続がキャンセルされました。";

    case "provider_failed":
      return "接続に失敗しました。もう一度お試しください。";

    case "multiple_active":
      return "接続状態に問題があります。再接続してください。";

    case "confirm_timeout":
      return "接続の確認に時間がかかっています。しばらくしてから更新してください。";

    default:
      return "接続に失敗しました。もう一度お試しください。";

  }

}

// 一覧取得(GET)自体が失敗した場合の固定文言。HTTP statusごとに
// 詳細を出し分けない(raw errorを見せない、既存
// components/research/ResearchWorkspace.tsxのdescribeErrorResponse()
// と同じ「固定文言」方針だが、Connection画面はstatus別の文言を
// 増やす必要が無いため単一の文言にとどめる)。
export function describeConnectionListError(): string {

  return "接続状態を取得できませんでした。しばらくしてから再度お試しください。";

}
