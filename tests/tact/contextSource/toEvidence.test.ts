// =========================
// TACT Context Source — Local Workspace Evidence変換 Regression (LW-P0)
// =========================
//
// 対象: core/tact-context-source/localWorkspace/toEvidence.ts
// (localWorkspaceReadResultToEvidence・localWorkspaceReadResultsToEvidence)。
//
// 環境制約: DOM/IndexedDB/File System Access APIは一切使わない。
// LLM/Search API呼び出しも0(pure functionのみのCategory A Test)。

import "dotenv/config";
import {
  localWorkspaceReadResultToEvidence,
  localWorkspaceReadResultsToEvidence,
} from "../../../core/tact-context-source/localWorkspace/toEvidence";
import type { LocalWorkspaceReadResult } from "../../../core/tact-context-source/localWorkspace/types";
import { check, summarize, type CheckResult } from "../lib/check";

const WORKSPACE_ID = "ws-test-1";

function makeRead(overrides: Partial<LocalWorkspaceReadResult["file"]> = {}, content = "hello"): LocalWorkspaceReadResult {
  return {
    file: {
      name: "notes.md",
      relativePath: "docs/notes.md",
      type: "file",
      size: 123,
      modifiedAt: "2026-08-29T00:00:00.000Z",
      mimeType: "text/markdown",
      extension: "md",
      ...overrides,
    },
    content,
    truncated: false,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // 基本のEvidence変換
  // ==========================================================

  const read = makeRead();
  const result = localWorkspaceReadResultToEvidence({ workspaceId: WORKSPACE_ID, read });

  results.push(
    check(
      "[Test1-1] evidence.evidenceにファイル本文がそのまま保持される",
      result.evidence.evidence === "hello"
    )
  );

  results.push(
    check(
      "[Test1-2] evidence.claimはfile.name",
      result.evidence.claim === "notes.md"
    )
  );

  results.push(
    check(
      "[Test1-3] sourceTypeはuser_file(既存Attachment Evidenceと同じ分類)",
      result.evidence.sourceType === "user_file"
    )
  );

  results.push(
    check(
      "[Test1-4] tagsにlocal_workspaceが含まれる",
      result.evidence.tags.includes("local_workspace")
    )
  );

  // ==========================================================
  // Provenance維持
  // ==========================================================

  results.push(
    check(
      "[Test2-1] provenance.sourceTypeはlocal_workspace",
      result.provenance.sourceType === "local_workspace"
    )
  );

  results.push(
    check(
      "[Test2-2] provenanceにworkspaceId/relativePath/fileNameが維持される",
      result.provenance.workspaceId === WORKSPACE_ID &&
        result.provenance.relativePath === "docs/notes.md" &&
        result.provenance.fileName === "notes.md"
    )
  );

  results.push(
    check(
      "[Test2-3] provenanceにmodifiedAt/sizeが維持される",
      result.provenance.modifiedAt === "2026-08-29T00:00:00.000Z" &&
        result.provenance.size === 123
    )
  );

  // ==========================================================
  // 空contentの安全な扱い
  // ==========================================================

  const emptyRead = makeRead({ name: "empty.txt", relativePath: "empty.txt" }, "");
  const emptyResult = localWorkspaceReadResultToEvidence({ workspaceId: WORKSPACE_ID, read: emptyRead });

  results.push(
    check(
      "[Test3-1] 空contentでも例外を投げず、evidence.evidence=\"\"となる",
      emptyResult.evidence.evidence === "" && emptyResult.provenance.fileName === "empty.txt"
    )
  );

  // ==========================================================
  // 決定論的出力(時刻に依存しないフィールド)
  // ==========================================================

  const again = localWorkspaceReadResultToEvidence({ workspaceId: WORKSPACE_ID, read });

  results.push(
    check(
      "[Test4-1] 同じ入力なら id/claim/source/provenanceは常に同じ値になる(createdAtを除く)",
      result.evidence.id === again.evidence.id &&
        result.evidence.claim === again.evidence.claim &&
        result.evidence.source === again.evidence.source &&
        JSON.stringify(result.provenance) === JSON.stringify(again.provenance)
    )
  );

  results.push(
    check(
      "[Test4-2] idはworkspaceIdとrelativePathから決定論的に導出される",
      result.evidence.id === `local_workspace:${WORKSPACE_ID}:docs/notes.md`
    )
  );

  // ==========================================================
  // 複数件変換
  // ==========================================================

  const batch = localWorkspaceReadResultsToEvidence(WORKSPACE_ID, [
    makeRead({ name: "a.md", relativePath: "a.md" }, "A"),
    makeRead({ name: "b.md", relativePath: "b.md" }, "B"),
  ]);

  results.push(
    check(
      "[Test5-1] localWorkspaceReadResultsToEvidenceは入力件数と同じ件数を返す",
      batch.length === 2 &&
        batch[0].evidence.claim === "a.md" &&
        batch[1].evidence.claim === "b.md"
    )
  );

  return summarize("contextSource/toEvidence", results);

}
