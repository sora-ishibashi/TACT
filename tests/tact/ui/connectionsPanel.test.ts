// =========================
// TACT UI — Connections Panel Regression (PRODUCT-P1: Connection UX)
// =========================
//
// 対象: components/tact/connections/aggregateConnectionStatus.ts・
// components/tact/connections/integrationCatalog.ts。いずれも純粋関数
// /静的データであり、DOM・React render・fetchのいずれにも依存しない
// (このrepositoryにReact component testing infrastructureが存在しない
// ため、既存方針通りpure logicだけを検証する、既存precedent:
// tests/tact/research/localWorkspacePreview.test.ts等が既に
// components/配下のpure functionをimportしてテストしている)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateConnectionStatus } from "../../../components/tact/connections/aggregateConnectionStatus";
import { INTEGRATION_CATALOG } from "../../../components/tact/connections/integrationCatalog";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A. 未接続(行が1件も無い) -> not_connected ----
  results.push(
    check(
      "[A] Connection行が0件 -> not_connected(接続ボタンを表示する状態)",
      aggregateConnectionStatus([], "gmail") === "not_connected"
    )
  );

  // ---- B. active 1件 -> connected ----
  results.push(
    check(
      "[B] active 1件 -> connected(接続済み)",
      aggregateConnectionStatus([{ service: "gmail", status: "active" }], "gmail") === "connected"
    )
  );

  // ---- C. pending 1件のみ(activeなし) -> connecting ----
  results.push(
    check(
      "[C] active無し・pending 1件 -> connecting(接続中)",
      aggregateConnectionStatus([{ service: "gmail", status: "pending" }], "gmail") === "connecting"
    )
  );

  // ---- D. revoked/failedだけ -> not_connected ----
  results.push(
    check(
      "[D] revoked/failedのみ(active・pendingいずれも無し) -> not_connected",
      aggregateConnectionStatus(
        [
          { service: "gmail", status: "revoked" },
          { service: "gmail", status: "failed" },
        ],
        "gmail"
      ) === "not_connected"
    )
  );

  // ---- E. historical rowsが複数あってもactive 1なら connected ----
  results.push(
    check(
      "[E] historical(revoked×2・failed×1・pending×1)+active×1が混在してもconnected(historical rowsは無視される、Gmail LIVE-1Aで実際に発生した構成)",
      aggregateConnectionStatus(
        [
          { service: "gmail", status: "revoked" },
          { service: "gmail", status: "revoked" },
          { service: "gmail", status: "failed" },
          { service: "gmail", status: "pending" },
          { service: "gmail", status: "active" },
        ],
        "gmail"
      ) === "connected"
    )
  );

  // ---- F. active 2件 -> error(fail-closed) ----
  results.push(
    check(
      "[F] active 2件 -> error(fail-closed、通常発生しない想定の異常状態)",
      aggregateConnectionStatus(
        [
          { service: "gmail", status: "active" },
          { service: "gmail", status: "active" },
        ],
        "gmail"
      ) === "error"
    )
  );

  // ---- N. Gmail/Slack両方で同じロジックが独立して機能する(他serviceの
  // 行に影響されない) ----
  results.push(
    check(
      "[N] 他serviceの行(Slack active)はGmailの集約に影響しない、両serviceは独立に判定される",
      aggregateConnectionStatus(
        [
          { service: "slack", status: "active" },
          { service: "gmail", status: "pending" },
        ],
        "gmail"
      ) === "connecting" &&
        aggregateConnectionStatus(
          [
            { service: "slack", status: "active" },
            { service: "gmail", status: "pending" },
          ],
          "slack"
        ) === "connected"
    )
  );

  // =========================
  // O. integrationCatalog: 将来service追加が1 entryで可能な構造
  // =========================

  results.push(
    check(
      "[O] integrationCatalogは現時点でGmail/Slackのちょうど2 entryのみを持つ(Notion/Drive/Calendar等へは今回拡張しない)",
      INTEGRATION_CATALOG.length === 2 &&
        INTEGRATION_CATALOG.some((e) => e.service === "gmail") &&
        INTEGRATION_CATALOG.some((e) => e.service === "slack")
    )
  );

  results.push(
    check(
      "[O] 各entryはservice/name/description/enabledの4 fieldだけを持つ(Provider詳細を持たない構造)",
      INTEGRATION_CATALOG.every(
        (entry) =>
          typeof entry.service === "string" &&
          typeof entry.name === "string" &&
          typeof entry.description === "string" &&
          typeof entry.enabled === "boolean" &&
          Object.keys(entry).sort().join(",") === "description,enabled,name,service"
      )
    )
  );

  // 絶対条件が守っているのは「ユーザーへ見せるデータ・文言・実行時の
  // import境界」であり、開発者向けコメント中の説明的な言及
  // (「Composio(実装詳細)を意識しない設計にする」等)まで機械的に
  // 禁止するものではない(このrepository全体の既存コメント慣習とも
  // 矛盾する)。そのため、catalog dataの実際の値(name/description)
  // だけを対象にする。
  results.push(
    check(
      "[O] catalogの実データ(name/description)はProvider名(composio)を一切含まない(コメントは対象外、ユーザーへ見せる値そのものの確認)",
      INTEGRATION_CATALOG.every(
        (entry) => !/composio/i.test(entry.name) && !/composio/i.test(entry.description)
      )
    )
  );

  const connectionsPanelSource = readRepoFile("components/tact/connections/ConnectionsPanel.tsx");

  results.push(
    check(
      "[絶対条件] ConnectionsPanel.tsxはComposio provider実装(core/tact-integration/providers/composio/配下)を一切importしない(UI層とProvider実装の境界、構造的な確認)",
      !/from ["'].*providers\/composio/.test(connectionsPanelSource) &&
        !/@composio\/(core|client)/.test(connectionsPanelSource)
    )
  );

  results.push(
    check(
      "[絶対条件] ConnectionsPanel.tsxはproviderConnectionRef/connection.providerという実際のproperty accessを一切行わない(GET /api/tact/connectionsのsanitize済みresponse以上の情報を前提にしない。文言としての言及(コメント等)は対象外——実際に`.providerConnectionRef`/`.provider`とアクセスしているかだけを見る)",
      !/\.providerConnectionRef\b/.test(connectionsPanelSource) &&
        !/\.provider\b(?!ed|s\b)/.test(connectionsPanelSource)
    )
  );

  return summarize("ui/connectionsPanel", results);

}
