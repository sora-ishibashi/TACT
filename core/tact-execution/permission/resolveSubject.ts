// =========================
// TACT Canonical Execution — Permission Context Resolver (SOR-51)
// =========================
//
// Canonical Execution → Permission Context Resolver → Permission Policy
// Resolver → Permission Evaluator、というpipelineの最初の境界。
//
// 絶対条件(SOR-51指示「Subject Resolution」): 過剰なActor Registryを
// 新設しない。Executionが既に持つactorKind/actorId(../types.ts、SOR-50
// で確立済み)から機械的にSubjectを導出するだけで、解決できない場合
// (actorIdがnull等)は無理にPermission Subjectを補わない——後続の
// Permission Policy Resolverがmatchしなければ自然にunknownへ倒れる
// (推測でallowedにしない、絶対条件)。

import type { CanonicalExecution } from "../types";
import type { PermissionSubject } from "./types";

export function resolvePermissionSubject(execution: CanonicalExecution): PermissionSubject {

  return {
    kind: execution.actorKind,
    id: execution.actorId,
  };

}
