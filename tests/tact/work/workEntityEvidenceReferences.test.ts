// =========================
// TACT Work — SOR-75 (WORK-ENTITY-P0) WorkEntity Invariants
// =========================
//
// SOR-75の対象は新しいテーブルではない。core/tact-work/types.tsの
// WorkEvidenceReference(Work.evidenceRefsのjsonb配列要素)が既に
// provider-neutralな「WorkEntity」——Workと外部business objectを結ぶ
// 型付きリンク——として機能しており、
// core/tact-execution/correlation/stages/structural.tsの
// runNotionStructuralCorrelation()がlistWorksForNotionResource()経由で
// 既にExecution resource metadataからWork candidateを生成している
// (既存Correlatorの再実装はしない、絶対条件)。
//
// このfileはSOR-75で追加したprovenance/confidence field(relationType/
// source/confidence/createdAt/canonicalEntityId、いずれもoptionalで
// migration不要)がSOR-75の必須invariantを満たすことを検証する:
//   - confidence/canonicalEntityIdを絶対に捏造しない(値を持たない producer
//     しか存在しないため、常にundefinedのまま)
//   - tenant識別子(userId等)をentry自体へ複製しない(tenant scopeは
//     常に親Workの列のみに存在する、唯一の真実源)
//   - raw provider content(text/title)を一切保存しない(既存
//     tests/tact/work/delegatedWork.test.tsの補完)
//   - 同一入力からは決定論的に同一出力(重複生成が非決定的でない)
//   - 重複evidence itemはdedupされる
//   - 異なるprovider(sourceType)の同一sourceRef文字列は、Postgresの
//     jsonb containment(`@>`)演算子の意味論上、互いを誤って
//     マッチしない(cross-provider collision無し)

import { buildWorkEvidenceReferences } from "../../../core/tact-work/delegatedIntent";
import type { ContextResolutionResult } from "../../../core/tact-context-resolution";
import type { WorkEvidenceReference } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function resolutionWithEvidence(evidence: ContextResolutionResult["pack"]["evidence"]): ContextResolutionResult {
  return {
    plan: {
      kind: "ready",
      requestText: "これ確認して",
      subject: { summary: "テスト案件", queryTerms: ["テスト案件"] },
      sources: {},
    },
    pack: {
      request: { text: "これ確認して" },
      subject: { summary: "テスト案件", queryTerms: ["テスト案件"] },
      evidence,
      metrics: { evidenceCount: evidence.length, totalChars: 0, truncated: false },
    },
    sources: {},
  };
}

// Postgresのjsonb containment演算子(`@>`)の意味論をそのまま実装した
// pure関数(実DB接続なし、documented semanticsの直接検証——
// tests/tact/work/listWorksForNotionResourceQueryEncoding.test.tsと同じ
// 「実際のquery/operatorの挙動を、ライブラリ/DBを呼ばずに検証する」方針)。
// object containment: filterの全keyがcandidate側に同じ値で存在すれば true。
function jsonbObjectContains(candidate: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => candidate[key] === value);
}

const KNOWN_WORK_EVIDENCE_REFERENCE_KEYS: readonly (keyof WorkEvidenceReference)[] = [
  "category", "sourceType", "sourceRef", "operation",
  "relationType", "source", "confidence", "createdAt", "canonicalEntityId",
];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 新規field(relationType/source/createdAt)がbuild時に付与される ----
  {
    const fixedNow = () => new Date("2026-09-26T00:00:00.000Z");
    const refs = buildWorkEvidenceReferences(
      resolutionWithEvidence([
        { category: "organizational", sourceType: "notion", sourceRef: "page-1", text: "raw body", title: "raw title", provenance: { operation: "read_page" } },
      ]),
      fixedNow
    );

    results.push(check(
      "[SOR-75] buildWorkEvidenceReferences()はrelationType='evidence'/source='context_resolution'/createdAtを付与する",
      refs.length === 1 &&
        refs[0].relationType === "evidence" &&
        refs[0].source === "context_resolution" &&
        refs[0].createdAt === "2026-09-26T00:00:00.000Z"
    ));

    results.push(check(
      "[SOR-75/No-Fabrication] confidence/canonicalEntityIdはproducerが存在しないため常にundefinedのまま(推測で埋めない)",
      refs[0].confidence === undefined && refs[0].canonicalEntityId === undefined
    ));

    results.push(check(
      "[SOR-75/Tenant hygiene] entry自体はWorkEvidenceReferenceの既知keyのみを持ち、userId/tenantId等を複製しない(tenant scopeは常に親Workの列のみに存在する)",
      Object.keys(refs[0]).every((key) => (KNOWN_WORK_EVIDENCE_REFERENCE_KEYS as readonly string[]).includes(key))
    ));

    results.push(check(
      "[SOR-75/Privacy, delegatedWork.test.tsの補完] raw provider content(text/title)は一切含まれない",
      !JSON.stringify(refs).includes("raw body") && !JSON.stringify(refs).includes("raw title")
    ));
  }

  // ---- 決定論性: 同一入力・同一nowなら同一出力 ----
  {
    const fixedNow = () => new Date("2026-09-26T00:00:00.000Z");
    const resolution = resolutionWithEvidence([
      { category: "conversation", sourceType: "slack", sourceRef: "msg-1", text: "t", provenance: {} },
      { category: "organizational", sourceType: "notion", sourceRef: "page-1", text: "t", provenance: { operation: "read_page" } },
    ]);

    const first = buildWorkEvidenceReferences(resolution, fixedNow);
    const second = buildWorkEvidenceReferences(resolution, fixedNow);

    results.push(check(
      "[SOR-75/Determinism] 同一のContextResolutionResult・同一nowからは、常に同一のWorkEvidenceReference配列が生成される",
      JSON.stringify(first) === JSON.stringify(second)
    ));
  }

  // ---- dedup: 同一(category, sourceType, sourceRef, operation)は1件に集約 ----
  {
    const refs = buildWorkEvidenceReferences(
      resolutionWithEvidence([
        { category: "organizational", sourceType: "notion", sourceRef: "page-1", text: "a", provenance: { operation: "read_page" } },
        { category: "organizational", sourceType: "notion", sourceRef: "page-1", text: "b(別のtimestampの同じevidence再取得)", provenance: { operation: "read_page" } },
      ])
    );

    results.push(check(
      "[SOR-75/Idempotent dedup] 同一の(category, sourceType, sourceRef, operation)を持つ重複evidenceは1件のWorkEntityへ集約される(新規fieldを追加しても既存dedupロジックは壊れない)",
      refs.length === 1
    ));
  }

  // ---- cross-provider collision無し: 同一sourceRef文字列でもsourceTypeが
  // 異なれば、jsonb containment上は互いにマッチしない(SOR-52 Closeout
  // Hardening Part8と同じ精神——bare IDだけで別providerのentityを
  // 誤認しない) ----
  {
    const sharedRefValue = "shared-id-that-happens-to-collide";

    const refs = buildWorkEvidenceReferences(
      resolutionWithEvidence([
        { category: "conversation", sourceType: "slack", sourceRef: sharedRefValue, text: "t", provenance: {} },
        { category: "organizational", sourceType: "notion", sourceRef: sharedRefValue, text: "t", provenance: { operation: "read_page" } },
      ])
    );

    const notionFilter = { sourceType: "notion", sourceRef: sharedRefValue };
    const slackEntry = refs.find((r) => r.sourceType === "slack") as unknown as Record<string, unknown>;
    const notionEntry = refs.find((r) => r.sourceType === "notion") as unknown as Record<string, unknown>;

    results.push(check(
      "[SOR-75/Cross-provider no collision] 同一sourceRef文字列を持つSlack/Notionの2 WorkEntityがあっても、" +
        "listWorksForNotionResource()のjsonb containment filter({sourceType:'notion', sourceRef}) はNotion側だけにマッチし、" +
        "Slack側の同名sourceRefを誤ってNotion resourceの候補として拾わない(Postgres `@>` object containment semantics)",
      jsonbObjectContains(notionEntry, notionFilter) === true &&
        jsonbObjectContains(slackEntry, notionFilter) === false
    ));
  }

  return summarize("TACT Work — SOR-75 WorkEntity (WorkEvidenceReference) Invariants", results);

}
