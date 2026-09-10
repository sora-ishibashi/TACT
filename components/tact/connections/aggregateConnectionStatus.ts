// =========================
// aggregateConnectionStatus (PRODUCT-P1: Connection UX)
// =========================
//
// GET /api/tact/connections が返す生の行(historical pending/revoked/
// failedを含みうる)を、Settings画面が表示すべき「意味のある1つの
// 状態」へ集約する純粋関数。サーバーを一切呼ばない・DOM/browser API
// にも依存しない(既存tests/tact/配下のpure function testと同じ
// 検証容易性)。
//
// 絶対条件(TACT PRODUCT-P1指示、Connection List UI):
//   - active が1件 -> "connected"
//   - active が0件 + pending が1件以上 -> "connecting"
//   - active も pending も0件(revoked/failedのみ、または0件) ->
//     "not_connected"
//   - active が2件以上 -> "error"(fail-closedな表示、通常は
//     発生しない想定)
//   - historical rows(revoked/failed)自体は判定に一切影響しない
//     ——このUIはそれらを個別の行として一覧表示しない。

export type ConnectionUiStatus =
  | "not_connected"
  | "connecting"
  | "connected"
  | "error";

// app/api/tact/connections/route.tsのtoPublicConnection()が返す形の
// うち、この集約に必要な最小限のfieldだけを要求する(UI層は
// providerConnectionRef等、公開されていないfieldの存在を前提にしない)。
export interface AggregatableConnection {
  service: string;
  status: "pending" | "active" | "failed" | "revoked";
}

export function aggregateConnectionStatus(
  connections: readonly AggregatableConnection[],
  service: string
): ConnectionUiStatus {

  const relevant = connections.filter((connection) => connection.service === service);

  const activeCount = relevant.filter((connection) => connection.status === "active").length;

  if (activeCount > 1) {
    return "error";
  }

  if (activeCount === 1) {
    return "connected";
  }

  const hasPending = relevant.some((connection) => connection.status === "pending");

  if (hasPending) {
    return "connecting";
  }

  return "not_connected";

}
