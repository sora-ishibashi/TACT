// =========================
// TACT Context Source — Local Workspace → Evidence変換 (LW-P0)
// =========================
//
// 読み取ったLocal Workspace fileを、既存Evidence形式
// (core/context/types.ts、無変更)へ安全に変換するpure function。
// Attachment pipeline(core/tact-attachment/)は変更しない・importしない
// (別sourceとして扱う)。
//
// 重要: ファイル内容はuntrusted source materialである。ここでは内容を
// Evidence.evidenceへそのまま保持するだけで、内容中の指示文を
// TACTの命令として解釈・実行する処理は一切行わない。「Evidenceへ
// untrustedなsource materialとして載せる」ことと「その中身を実行する」
// ことは全く別であり、後者はこのファイルは勿論、LW-P0のどの層でも
// 行わない。将来Research等へ統合する際も、既存の
// attachmentSafetyInstruction(core/tact-research/contextAssembly.ts)と
// 同種の安全指示を付加する責務は統合先(未実装)が持つ。

import type { Evidence } from "../../context/types";
import type { ContextSourceReadResult } from "../types";
import type {
  LocalWorkspaceEvidence,
  LocalWorkspaceProvenance,
  LocalWorkspaceReadResult,
} from "./types";

const DEFAULT_CREATED_BY = "local-workspace-context-source";

export interface LocalWorkspaceEvidenceInput {
  workspaceId: string;
  read: LocalWorkspaceReadResult;
  // 呼び出し元がcreatedByを明示したい場合のみ上書きする
  // (省略時はDEFAULT_CREATED_BYで一貫させる)。
  createdBy?: string;
}

export function localWorkspaceReadResultToEvidence(
  input: LocalWorkspaceEvidenceInput
): LocalWorkspaceEvidence {

  const { workspaceId, read, createdBy = DEFAULT_CREATED_BY } = input;
  const { file, content } = read;

  const provenance: LocalWorkspaceProvenance = {
    sourceType: "local_workspace",
    workspaceId,
    relativePath: file.relativePath,
    fileName: file.name,
    modifiedAt: file.modifiedAt,
    size: file.size,
  };

  // id/claim/source/tags/provenanceは呼び出し時刻に依存せず、
  // (workspaceId, relativePath)から決定論的に定まる
  // (createdAtのみ現在時刻を使う。既存のbuildAttachmentEvidence()と
  // 同じ方針)。
  const evidence: Evidence = {
    id: `local_workspace:${workspaceId}:${file.relativePath}`,
    claim: file.name,
    evidence: content,
    source: `local-workspace://${workspaceId}/${file.relativePath}`,
    sourceType: "user_file",
    confidence: "medium",
    score: 0,
    createdBy,
    createdAt: Date.now(),
    tags: ["local_workspace", "user_file"],
    references: [],
  };

  return { evidence, provenance };

}

export function localWorkspaceReadResultsToEvidence(
  workspaceId: string,
  reads: LocalWorkspaceReadResult[],
  createdBy?: string
): LocalWorkspaceEvidence[] {

  return reads.map((read) =>
    localWorkspaceReadResultToEvidence({ workspaceId, read, createdBy })
  );

}

// =========================
// ContextSource.read() → LocalWorkspaceEvidence (LW-P2)
// =========================
//
// browserAdapter.tsのread()はContextSource contract(entry/content/
// truncated)を満たすContextSourceReadResultを返す。LocalWorkspaceEvidence
// への変換にはfile(LocalWorkspaceFile)というより具体的な形が必要なため、
// ここで橋渡しする。entry.typeが"file"であることを前提とする
// (directoryのread()は呼び出し元でLocalWorkspaceIsDirectoryErrorとして
// 既に弾かれている)。

export function contextSourceReadResultToLocalWorkspaceReadResult(
  result: ContextSourceReadResult
): LocalWorkspaceReadResult {

  if (result.entry.type !== "file") {
    throw new Error(
      "contextSourceReadResultToLocalWorkspaceReadResult: entry must be a file"
    );
  }

  return {
    file: { ...result.entry, type: "file" },
    content: result.content,
    truncated: result.truncated,
  };

}

export function contextSourceReadResultToEvidence(
  workspaceId: string,
  result: ContextSourceReadResult,
  createdBy?: string
): LocalWorkspaceEvidence {

  return localWorkspaceReadResultToEvidence({
    workspaceId,
    read: contextSourceReadResultToLocalWorkspaceReadResult(result),
    createdBy,
  });

}
