// =========================
// TACT Context Source — Local Workspace Evidence Request Validation
// Regression (LW-P3)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/requestValidation.tsの
// validateWorkspaceEvidence()。Clientから送られてきたworkspaceEvidenceを
// serverが無条件に信頼しないための検証(schema/上限/provenance整合性)。
//
// 環境制約: DOM/File System Access APIには一切依存しない(server-safe)。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。

import "dotenv/config";
import {
  MAX_WORKSPACE_EVIDENCE_ITEMS,
  MAX_WORKSPACE_EVIDENCE_ITEM_CHARS,
  MAX_WORKSPACE_EVIDENCE_TOTAL_CHARS,
  validateWorkspaceEvidence,
} from "../../../core/tact-context-source/localWorkspace/requestValidation";
import { check, summarize, type CheckResult } from "../lib/check";

function validItem(overrides: {
  relativePath?: string;
  fileName?: string;
  content?: string;
  id?: string;
  workspaceId?: string;
} = {}): unknown {

  const workspaceId = overrides.workspaceId ?? "ws-1";
  const relativePath = overrides.relativePath ?? "memo.txt";
  const fileName = overrides.fileName ?? relativePath.split("/").pop();
  const content = overrides.content ?? "hello world";

  return {
    evidence: {
      id: overrides.id ?? `local_workspace:${workspaceId}:${relativePath}`,
      claim: fileName,
      evidence: content,
      source: `local-workspace://${workspaceId}/${relativePath}`,
      sourceType: "user_file",
      confidence: "medium",
      score: 0,
      createdBy: "local-workspace-context-source",
      createdAt: Date.now(),
      tags: ["local_workspace", "user_file"],
      references: [],
    },
    provenance: {
      sourceType: "local_workspace",
      workspaceId,
      relativePath,
      fileName,
    },
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // 有効なEvidence
  // ==========================================================

  {
    const result = validateWorkspaceEvidence([validItem(), validItem({ relativePath: "docs/research.md" })]);

    results.push(
      check(
        "[Test1-1] 有効なworkspaceEvidence(2件)はok:trueで受理される",
        result.ok === true && result.ok && result.workspaceEvidence.length === 2
      )
    );

  }

  results.push(
    check(
      "[Test1-2] undefined/nullは空配列としてok:trueで受理される(既存Turnとの後方互換)",
      (() => {
        const undefinedResult = validateWorkspaceEvidence(undefined);
        const nullResult = validateWorkspaceEvidence(null);
        return (
          undefinedResult.ok === true &&
          undefinedResult.ok &&
          undefinedResult.workspaceEvidence.length === 0 &&
          nullResult.ok === true &&
          nullResult.ok &&
          nullResult.workspaceEvidence.length === 0
        );
      })()
    )
  );

  results.push(
    check(
      "[Test1-3] 配列でない値はreject",
      validateWorkspaceEvidence({ not: "an array" }).ok === false
    )
  );

  // ==========================================================
  // Path traversal reject
  // ==========================================================

  {
    const item = validItem({ relativePath: "../secret.txt", fileName: "secret.txt" }) as { provenance: { relativePath: string } };
    // sourceとrelativePathの整合性はvalidItem()側で既に取れているため、
    // traversal自体がreject理由になることを確認する。
    const result = validateWorkspaceEvidence([item]);

    results.push(
      check(
        "[Test2-1] provenance.relativePathの\"../\"はreject",
        result.ok === false
      )
    );

  }

  results.push(
    check(
      "[Test2-2] 絶対path(先頭スラッシュ)もreject",
      validateWorkspaceEvidence([
        validItem({ relativePath: "/etc/passwd", fileName: "passwd" }),
      ]).ok === false
    )
  );

  results.push(
    check(
      "[Test2-3] 除外対象path(node_modules配下)もreject(defense in depth)",
      validateWorkspaceEvidence([
        validItem({ relativePath: "node_modules/pkg/index.js", fileName: "index.js" }),
      ]).ok === false
    )
  );

  results.push(
    check(
      "[Test2-4] 隠しfile(.env)由来のprovenanceもreject",
      validateWorkspaceEvidence([
        validItem({ relativePath: ".env", fileName: ".env" }),
      ]).ok === false
    )
  );

  // ==========================================================
  // Oversized content reject
  // ==========================================================

  results.push(
    check(
      `[Test3-1] 1件のcontentがMAX_WORKSPACE_EVIDENCE_ITEM_CHARS(${MAX_WORKSPACE_EVIDENCE_ITEM_CHARS})を超えるとreject`,
      validateWorkspaceEvidence([
        validItem({ content: "x".repeat(MAX_WORKSPACE_EVIDENCE_ITEM_CHARS + 1) }),
      ]).ok === false
    )
  );

  results.push(
    check(
      `[Test3-2] 合計contentがMAX_WORKSPACE_EVIDENCE_TOTAL_CHARS(${MAX_WORKSPACE_EVIDENCE_TOTAL_CHARS})を超えるとreject(個々は上限以内)`,
      validateWorkspaceEvidence([
        validItem({ relativePath: "a.txt", content: "x".repeat(20_000) }),
        validItem({ relativePath: "b.txt", content: "x".repeat(20_000) }),
        validItem({ relativePath: "c.txt", content: "x".repeat(20_000) }),
      ]).ok === false
    )
  );

  // ==========================================================
  // 件数上限
  // ==========================================================

  results.push(
    check(
      `[Test4-1] MAX_WORKSPACE_EVIDENCE_ITEMS(${MAX_WORKSPACE_EVIDENCE_ITEMS})件までは受理される`,
      validateWorkspaceEvidence(
        Array.from({ length: MAX_WORKSPACE_EVIDENCE_ITEMS }, (_, i) =>
          validItem({ relativePath: `f${i}.txt` })
        )
      ).ok === true
    )
  );

  results.push(
    check(
      `[Test4-2] MAX_WORKSPACE_EVIDENCE_ITEMS(${MAX_WORKSPACE_EVIDENCE_ITEMS})件を超えるとreject`,
      validateWorkspaceEvidence(
        Array.from({ length: MAX_WORKSPACE_EVIDENCE_ITEMS + 1 }, (_, i) =>
          validItem({ relativePath: `f${i}.txt` })
        )
      ).ok === false
    )
  );

  // ==========================================================
  // Malformed provenance reject
  // ==========================================================

  results.push(
    check(
      "[Test5-1] provenance自体が欠落している場合はreject",
      validateWorkspaceEvidence([{ evidence: (validItem() as { evidence: unknown }).evidence }]).ok === false
    )
  );

  results.push(
    check(
      "[Test5-2] provenance.sourceTypeが\"local_workspace\"以外はreject",
      validateWorkspaceEvidence([
        {
          evidence: (validItem() as { evidence: unknown }).evidence,
          provenance: { sourceType: "attachment", workspaceId: "ws-1", relativePath: "memo.txt", fileName: "memo.txt" },
        },
      ]).ok === false
    )
  );

  results.push(
    check(
      "[Test5-3] provenance.fileNameがrelativePathの末尾segmentと不一致の場合はreject",
      validateWorkspaceEvidence([
        {
          evidence: (validItem({ relativePath: "docs/memo.txt" }) as { evidence: unknown }).evidence,
          provenance: {
            sourceType: "local_workspace",
            workspaceId: "ws-1",
            relativePath: "docs/memo.txt",
            fileName: "other.txt",
          },
        },
      ]).ok === false
    )
  );

  results.push(
    check(
      "[Test5-4] provenance.workspaceIdが空文字はreject",
      validateWorkspaceEvidence([
        validItem({ workspaceId: "" }),
      ]).ok === false
    )
  );

  // ==========================================================
  // evidence.sourceType / source scheme / provenance整合性
  // ==========================================================

  {
    const item = validItem() as { evidence: Record<string, unknown> };
    item.evidence.sourceType = "official";

    results.push(
      check(
        "[Test6-1] evidence.sourceTypeが\"user_file\"以外はreject",
        validateWorkspaceEvidence([item]).ok === false
      )
    );
  }

  {
    const item = validItem() as { evidence: Record<string, unknown> };
    item.evidence.source = "https://example.com/not-local-workspace";

    results.push(
      check(
        "[Test6-2] evidence.sourceがlocal-workspace://スキームでない場合はreject",
        validateWorkspaceEvidence([item]).ok === false
      )
    );
  }

  {
    const item = validItem() as { evidence: Record<string, unknown> };
    item.evidence.source = "local-workspace://different-workspace/memo.txt";

    results.push(
      check(
        "[Test6-3] evidence.sourceとprovenance(workspaceId/relativePath)が不一致の場合はreject",
        validateWorkspaceEvidence([item]).ok === false
      )
    );
  }

  // ==========================================================
  // 重複id reject
  // ==========================================================

  results.push(
    check(
      "[Test7-1] 同じevidence.idを持つitemが複数あるとreject",
      validateWorkspaceEvidence([
        validItem({ relativePath: "a.txt", id: "same-id" }),
        validItem({ relativePath: "b.txt", id: "same-id" }),
      ]).ok === false
    )
  );

  // ==========================================================
  // 未知フィールドがstripされる(再構築のみを信頼する)
  // ==========================================================

  {
    const item = validItem() as Record<string, unknown>;
    (item.evidence as Record<string, unknown>).unexpectedEvidenceField = "ignored";
    item.unexpectedTopLevelField = "ignored";

    const result = validateWorkspaceEvidence([item]);

    results.push(
      check(
        "[Test8-1] 未知フィールドを含んでいても、検証済みの値だけで再構築されたEvidenceが返る",
        result.ok === true &&
          result.ok &&
          !("unexpectedTopLevelField" in (result.workspaceEvidence[0] as unknown as Record<string, unknown>)) &&
          !("unexpectedEvidenceField" in result.workspaceEvidence[0].evidence)
      )
    );

  }

  return summarize("contextSource/requestValidation", results);

}
