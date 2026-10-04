// =========================
// TACT Canonical Execution — M-0 Canonical Permission Result (SOR-51)
// =========================
//
// SOR-51指示section4「Canonical Evaluation」: 既存の内部decision
// (PermissionDecisionStatus: allowed/denied/unknown/approval_required)
// が存在していても、product-facing canonical outputは以下の4値
// (MATCH/MISMATCH/UNKNOWN/APPROVAL_REQUIRED)である——内部vocabularyを
// リネームするのではなく、その上に薄い変換層を1つ追加する。
//
// このfile自身はNotion固有ではない(汎用的なmapping)。M-0時点で実際に
// 値を持つpolicyがNotionだけであるだけで、将来他providerのruleが
// 追加されても同じ変換をそのまま使える。

import type { PermissionDecisionStatus } from "./types";

export type CanonicalPermissionResult = "MATCH" | "MISMATCH" | "UNKNOWN" | "APPROVAL_REQUIRED";

export const CANONICAL_PERMISSION_RESULTS: readonly CanonicalPermissionResult[] = [
  "MATCH",
  "MISMATCH",
  "UNKNOWN",
  "APPROVAL_REQUIRED",
];

// MATCH: observed actionがregistered permission内(allowed)。
// MISMATCH: observed actionがregistered permissionに明示的に反する
//   (denied)。
// APPROVAL_REQUIRED: 実行可能性の可否ではなく、registered permissionが
//   人間承認必須と定義している(deniedへ丸めない、絶対条件)。
// UNKNOWN: 該当permission registrationが無い、subject/connection/action
//   解決不能、または安全に判断できない(推測しない)。
export function toCanonicalPermissionResult(status: PermissionDecisionStatus): CanonicalPermissionResult {

  switch (status) {
    case "allowed":
      return "MATCH";
    case "denied":
      return "MISMATCH";
    case "approval_required":
      return "APPROVAL_REQUIRED";
    case "unknown":
      return "UNKNOWN";
  }

}
