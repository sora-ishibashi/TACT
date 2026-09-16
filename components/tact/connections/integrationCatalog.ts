// =========================
// Integration Catalog (PRODUCT-P1: Connection UX)
// =========================
//
// Settings / Connections画面に表示するserviceの一覧。今後Notion/
// Google Drive/Google Calendar/Microsoft 365/Teams/LINE/Canva等を
// 追加する場合も、この配列へ1 entryを足すだけで済む構造にする
// (絶対条件7「service cardを追加するだけで拡張できる構造」)。
//
// 絶対条件(最重要): Provider(Composio)名・Composioという単語・
// Connected Account ID・Auth Config ID等のProvider詳細をこのfileへ
// 一切書かない——ここはユーザーに見せる名前・説明文・有効/無効フラグ
// だけを持つ、純粋なUI設定データ。実際の接続処理(OAuth/Provider
// 選択)はcore/tact-integration/(サーバー側)の責務であり、この
// fileはそれを一切知らない。
//
// 今回のPRODUCT-P1はGmail/Slackのみを対象とする(絶対条件:
// Notion/Drive/Calendarへは今回拡張しない)。将来serviceを追加する
// 際も、対応するCanonical IntegrationService
// (core/tact-integration/types.ts)がserver側で既にサポートされて
// いることを確認してからentryを追加すること(このcatalogはUI表示
// 専用であり、server側のサポート状況を保証するものではない)。
//
// TIME-P1c Calendar Connections UI: "google_calendar"を追加。server側
// (IntegrationService/Policy/Provisioning/Adapter/CapabilityBinding)は
// 既に完成済み(TIME-P1c Calendar Wiring)——このfileはUI表示専用の
// 追加であり、server側の能力を一切変更しない。絶対条件(最重要):
// Google Calendarは読み取り専用(空き時間の確認のみ)であり、
// 予定の作成・変更・削除・招待のいずれも実行できない。この事実が
// description文だけで確実に伝わるようにする(UI上に書き込み系の
// 操作を想起させるボタン・アイコン・文言を一切追加しない)。

export type CanonicalIntegrationService = "gmail" | "slack" | "notion" | "google_calendar";

export interface IntegrationCatalogEntry {

  service: CanonicalIntegrationService;

  // ユーザーへ見せる名前(Provider名ではない、例: "Gmail"であって
  // "Composio"ではない)。
  name: string;

  // カード上の説明文(1行、短く)。
  description: string;

  // false の場合、Settings画面上でこのserviceのcardを表示しない
  // (「準備中」を見せたい場合は、entry自体を足した上でこのUIの
  // 別の層で判断する——PRODUCT-P1時点ではfalseのentryを持たない)。
  enabled: boolean;

}

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    service: "gmail",
    name: "Gmail",
    description: "メールの検索・確認・返信に使用",
    enabled: true,
  },
  {
    service: "slack",
    name: "Slack",
    description: "TACTへの指示・通知に使用",
    enabled: true,
  },
  {
    service: "notion",
    name: "Notion",
    description: "社内情報やドキュメントの参照に使用",
    enabled: true,
  },
  {
    service: "google_calendar",
    name: "Google Calendar",
    description: "カレンダーの空き時間確認に使用(予定の作成・変更は行いません)",
    enabled: true,
  },
];
