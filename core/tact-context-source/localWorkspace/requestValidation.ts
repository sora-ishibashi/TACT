// =========================
// TACT Context Source — Local Workspace Evidence Request Validation
// (LW-P3)
// =========================
//
// 目的: Client(Workspace Context Resolver、core/tact-context-source/
// localWorkspace/resolver.ts + browserAdapter.ts)から送られてきた
// workspaceEvidenceを、server(app/api/tact/tact-conversations/route.ts)
// が無条件に信頼しないための検証。
//
// 重要な前提: Local Workspace contentは常にuntrusted source material
// である。ここでの検証は「JSONとして正しい形をしているか」
// (schema/型/上限)のみを保証し、file内容の真偽・実在性までは検証
// できない(既存attachmentEvidenceのvalidateAttachmentIds()と同じ
// 位置づけ)。検証を通過したitemは、受け取った値をそのまま
// 下流(runConversationOrchestration以降)へ流用せず、ここで検証済みの
// 値だけを使って新しいオブジェクトとして再構築する
// (client提供オブジェクトの未知フィールドを暗黙にstripし、
// 想定外フィールドの混入を防ぐ)。
//
// core/tact-attachment/validation.tsと同じスタイル(DBアクセス無し、
// 純粋なvalidation関数)。DOM/Browser API/File System Access APIには
// 一切依存しない(server routeから安全にimportできる)。

import { isRelativePathExcluded, validateRelativePath } from "../filtering";
import type { Evidence } from "../../context/types";
import type { LocalWorkspaceEvidence, LocalWorkspaceProvenance } from "./types";

// =========================
// Limits(Section3のBounded retrieval値と一致させる。client側の
// resolver.tsの上限を、server側でも独立して再確認する——defense in
// depth。client側の値を変更した場合はここも合わせて見直すこと)。
// =========================

export const MAX_WORKSPACE_EVIDENCE_ITEMS = 3;
export const MAX_WORKSPACE_EVIDENCE_ITEM_CHARS = 200_000;
export const MAX_WORKSPACE_EVIDENCE_TOTAL_CHARS = 50_000;

const MAX_WORKSPACE_ID_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_CLAIM_LENGTH = 500;
const MAX_SOURCE_LENGTH = 2_000;
const MAX_CREATED_BY_LENGTH = 200;

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high"]);

export type WorkspaceEvidenceValidationErrorCode = "workspace_evidence_invalid";

export interface WorkspaceEvidenceValidationFailure {
  ok: false;
  code: WorkspaceEvidenceValidationErrorCode;
  message: string;
}

export interface WorkspaceEvidenceValidationSuccess {
  ok: true;
  workspaceEvidence: LocalWorkspaceEvidence[];
}

export type WorkspaceEvidenceValidationResult =
  | WorkspaceEvidenceValidationSuccess
  | WorkspaceEvidenceValidationFailure;

function fail(message: string): WorkspaceEvidenceValidationFailure {
  return { ok: false, code: "workspace_evidence_invalid", message };
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// =========================
// provenance shape validation
// =========================
function validateProvenance(
  raw: unknown
): { ok: true; provenance: LocalWorkspaceProvenance } | WorkspaceEvidenceValidationFailure {

  if (!raw || typeof raw !== "object") {
    return fail("workspaceEvidence[].provenance must be an object.");
  }

  const record = raw as Record<string, unknown>;

  if (record.sourceType !== "local_workspace") {
    return fail("workspaceEvidence[].provenance.sourceType must be \"local_workspace\".");
  }

  if (!isNonEmptyString(record.workspaceId, MAX_WORKSPACE_ID_LENGTH)) {
    return fail("workspaceEvidence[].provenance.workspaceId must be a non-empty string.");
  }

  if (typeof record.relativePath !== "string") {
    return fail("workspaceEvidence[].provenance.relativePath must be a string.");
  }

  const pathValidation = validateRelativePath(record.relativePath);

  if (!pathValidation.ok) {
    return fail(
      `workspaceEvidence[].provenance.relativePath is invalid (${pathValidation.reason ?? "unknown"}).`
    );
  }

  // Local WorkspaceのDefault Exclude(node_modules/.git/.env/隠しfile等)
  // を、clientが主張するprovenanceに対しても再確認する(defense in
  // depth——client実装のbugや改ざんによって、除外対象のpathがEvidenceの
  // provenanceとして送られてくることを防ぐ)。
  if (isRelativePathExcluded(record.relativePath)) {
    return fail("workspaceEvidence[].provenance.relativePath refers to an excluded path.");
  }

  if (!isNonEmptyString(record.fileName, MAX_FILE_NAME_LENGTH)) {
    return fail("workspaceEvidence[].provenance.fileName must be a non-empty string.");
  }

  // relativePathの絶対path/traversalは既にvalidateRelativePath()で
  // reject済み。fileNameがrelativePathの最終segmentと一致することも
  // 確認する(provenanceの内部整合性)。
  const segments = record.relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1];

  if (lastSegment !== record.fileName) {
    return fail("workspaceEvidence[].provenance.fileName must match the last segment of relativePath.");
  }

  if (record.modifiedAt !== undefined && typeof record.modifiedAt !== "string") {
    return fail("workspaceEvidence[].provenance.modifiedAt must be a string when present.");
  }

  if (record.size !== undefined && !(isFiniteNumber(record.size) && record.size >= 0)) {
    return fail("workspaceEvidence[].provenance.size must be a non-negative number when present.");
  }

  const provenance: LocalWorkspaceProvenance = {
    sourceType: "local_workspace",
    workspaceId: record.workspaceId,
    relativePath: record.relativePath,
    fileName: record.fileName,
    modifiedAt: typeof record.modifiedAt === "string" ? record.modifiedAt : undefined,
    size: isFiniteNumber(record.size) ? record.size : undefined,
  };

  return { ok: true, provenance };

}

// =========================
// evidence shape validation
// =========================
function validateEvidence(
  raw: unknown
): { ok: true; evidence: Evidence } | WorkspaceEvidenceValidationFailure {

  if (!raw || typeof raw !== "object") {
    return fail("workspaceEvidence[].evidence must be an object.");
  }

  const record = raw as Record<string, unknown>;

  if (!isNonEmptyString(record.id, 500)) {
    return fail("workspaceEvidence[].evidence.id must be a non-empty string.");
  }

  if (!isNonEmptyString(record.claim, MAX_CLAIM_LENGTH)) {
    return fail("workspaceEvidence[].evidence.claim must be a non-empty string.");
  }

  if (typeof record.evidence !== "string") {
    return fail("workspaceEvidence[].evidence.evidence must be a string.");
  }

  if (record.evidence.length > MAX_WORKSPACE_EVIDENCE_ITEM_CHARS) {
    return fail(
      `workspaceEvidence[].evidence.evidence must be ${MAX_WORKSPACE_EVIDENCE_ITEM_CHARS} characters or fewer.`
    );
  }

  if (record.source !== undefined && !isNonEmptyString(record.source, MAX_SOURCE_LENGTH)) {
    return fail("workspaceEvidence[].evidence.source must be a non-empty string when present.");
  }

  // local-workspace://<workspaceId>/<relativePath>の形式のみ許可する
  // (他sourceType由来のEvidenceを、Local WorkspaceのEvidenceとして
  // 偽装させないため)。
  if (typeof record.source === "string" && !record.source.startsWith("local-workspace://")) {
    return fail("workspaceEvidence[].evidence.source must use the local-workspace:// scheme.");
  }

  if (record.sourceType !== "user_file") {
    return fail("workspaceEvidence[].evidence.sourceType must be \"user_file\".");
  }

  if (typeof record.confidence !== "string" || !CONFIDENCE_VALUES.has(record.confidence)) {
    return fail("workspaceEvidence[].evidence.confidence must be \"low\", \"medium\", or \"high\".");
  }

  if (!isFiniteNumber(record.score)) {
    return fail("workspaceEvidence[].evidence.score must be a finite number.");
  }

  if (!isNonEmptyString(record.createdBy, MAX_CREATED_BY_LENGTH)) {
    return fail("workspaceEvidence[].evidence.createdBy must be a non-empty string.");
  }

  if (!isFiniteNumber(record.createdAt)) {
    return fail("workspaceEvidence[].evidence.createdAt must be a finite number.");
  }

  if (
    !Array.isArray(record.tags) ||
    record.tags.some((tag) => typeof tag !== "string")
  ) {
    return fail("workspaceEvidence[].evidence.tags must be an array of strings.");
  }

  if (
    record.references !== undefined &&
    (!Array.isArray(record.references) || record.references.some((ref) => typeof ref !== "string"))
  ) {
    return fail("workspaceEvidence[].evidence.references must be an array of strings when present.");
  }

  const evidence: Evidence = {
    id: record.id,
    claim: record.claim,
    evidence: record.evidence,
    source: typeof record.source === "string" ? record.source : undefined,
    sourceType: "user_file",
    confidence: record.confidence as "low" | "medium" | "high",
    score: record.score,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    tags: record.tags as string[],
    references: Array.isArray(record.references) ? (record.references as string[]) : [],
  };

  return { ok: true, evidence };

}

function validateWorkspaceEvidenceItem(
  raw: unknown
): { ok: true; item: LocalWorkspaceEvidence } | WorkspaceEvidenceValidationFailure {

  if (!raw || typeof raw !== "object") {
    return fail("workspaceEvidence[] items must be objects.");
  }

  const record = raw as Record<string, unknown>;

  const evidenceResult = validateEvidence(record.evidence);

  if (!evidenceResult.ok) {
    return evidenceResult;
  }

  const provenanceResult = validateProvenance(record.provenance);

  if (!provenanceResult.ok) {
    return provenanceResult;
  }

  // provenance(workspaceId/relativePath)とevidence.sourceの整合性を
  // 確認する(どちらも同じfileを指しているはずであり、不一致は
  // 改ざん/bugの兆候として拒否する)。localWorkspaceReadResultToEvidence()
  // (toEvidence.ts)が生成するsource形式と完全一致させる。
  const expectedSource = `local-workspace://${provenanceResult.provenance.workspaceId}/${provenanceResult.provenance.relativePath}`;

  if (
    evidenceResult.evidence.source !== undefined &&
    evidenceResult.evidence.source !== expectedSource
  ) {
    return fail("workspaceEvidence[].evidence.source does not match provenance.");
  }

  return {
    ok: true,
    item: {
      evidence: evidenceResult.evidence,
      provenance: provenanceResult.provenance,
    },
  };

}

// =========================
// public entry point
// =========================
//
// value===undefined/nullは「Local Workspaceを利用しなかったTurn」を
// 表す(既存validateAttachmentIds()と同じ、省略可能な既定値)。
export function validateWorkspaceEvidence(value: unknown): WorkspaceEvidenceValidationResult {

  if (value === undefined || value === null) {
    return { ok: true, workspaceEvidence: [] };
  }

  if (!Array.isArray(value)) {
    return fail("workspaceEvidence must be an array.");
  }

  if (value.length > MAX_WORKSPACE_EVIDENCE_ITEMS) {
    return fail(`A turn can include at most ${MAX_WORKSPACE_EVIDENCE_ITEMS} Local Workspace files.`);
  }

  const workspaceEvidence: LocalWorkspaceEvidence[] = [];
  let totalChars = 0;
  const seenIds = new Set<string>();

  for (const raw of value) {

    const itemResult = validateWorkspaceEvidenceItem(raw);

    if (!itemResult.ok) {
      return itemResult;
    }

    if (seenIds.has(itemResult.item.evidence.id)) {
      return fail("workspaceEvidence must not contain duplicate evidence ids.");
    }

    seenIds.add(itemResult.item.evidence.id);

    totalChars += itemResult.item.evidence.evidence.length;

    if (totalChars > MAX_WORKSPACE_EVIDENCE_TOTAL_CHARS) {
      return fail(
        `workspaceEvidence total content must be ${MAX_WORKSPACE_EVIDENCE_TOTAL_CHARS} characters or fewer.`
      );
    }

    workspaceEvidence.push(itemResult.item);

  }

  return { ok: true, workspaceEvidence };

}
