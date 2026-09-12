import { createHash } from "node:crypto";
// REF-P1e: SourceReferentSnapshot(既存canonical、REF-P1aで確立済み)を
// 型のみ再利用する。core/tact-referent/types.tsは完全に自己完結した
// leaf module(他のいずれもimportしない)であり、このimportは
// ARCH-P1aの絶対条件(DB/core/tact-integration非依存)に抵触しない
// ——tact-referentはGmail/Slack/Composioの実行境界とは無関係な、
// 純粋domain typeのみを提供する。
import type { SourceReferentSnapshot } from "../tact-referent/types";

// =========================
// TACT Work — Approval Integrity (Architecture Migration ARCH-P1a)
// =========================
//
// docs/architecture/approval-integrity.mdで設計したApproval Subject
// (「Approvalは実際に何を承認しているのか」のcanonical・versioned・
// hashed表現)を構築・canonicalize・hash・比較する、純粋関数だけの
// module。
//
// 絶対条件(ARCH-P1a指示、最重要):
//   - DBアクセスを一切行わない(Supabase/core/tact-work/store.tsを
//     importしない)。
//   - Provider API・Slack・Composioへの依存を一切持たない
//     (core/tact-integration/配下を一切importしない)。
//   - このfile自身はcore/tact-work/approval.tsのrequestApproval()・
//     core/tact-integration/execution.tsのexecuteApprovedIntegrationAction()
//     のいずれからも呼ばれない(ARCH-P1aはcapture wiring・
//     execution-time verificationのいずれも行わない、Non-goals)。
//
// 設計判断(single source of truth、approval-integrity.md Step3):
// subjectVersionはApprovalSubject本体の中に埋め込まれる値が唯一の
// source of truthであり、DB側のsubject_version列(supabase/migrations/
// 20260909000000_add_tact_approvals_integrity_fields.sql)は検索用に
// 非正規化された「写し」にすぎない。verifyApprovalIntegrity()は、
// 渡された両方の値が一致することを確認した上で使う(不一致自体を
// stored_subject_invalidとして扱う)。
//
// Provider neutrality(絶対条件): ApprovalSubjectはservice/operation/
// canonicalInput/connectionId/riskClassSnapshotという、TACT canonical
// domainの語彙だけで構成される。Composio tool slug・connectedAccountId・
// providerConnectionRef等のProvider固有識別子、およびcredential/token/
// secretのいずれも一切含めない(approval-integrity.md Security
// Invariant 3・12)。

// =========================
// ApprovalSubject (version 1)
// =========================

export const APPROVAL_SUBJECT_VERSION = 1;

// TACT canonical risk classification(core/tact-integration/policy.ts
// のIntegrationRiskClassと同じ3値)。このfile自身はcore/tact-integration/
// を一切importしないため、値のunionとして独立に再宣言する(循環依存
// 回避、core/tact-work/execution.tsのExecuteReadIntegrationActionOutcome
// が既に使っている「値だけを再宣言する」既存パターンと同じ)。
export type ApprovalRiskClassSnapshot = "read" | "write" | "destructive";

// JSON-safeな値だけを許容する再帰的な型。undefined/function/symbol/
// bigint/Date等の非JSON値はこの型に現れない(canonicalizeJsonValue()の
// runtime validationが対応する)。
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApprovalSubject {

  subjectVersion: number;

  workId: string;

  taskId: string | null;

  service: string;

  operation: string;

  canonicalInput: JsonValue;

  connectionId: string | null;

  riskClassSnapshot: ApprovalRiskClassSnapshot | null;

  // =========================
  // sourceReferent (REF-P1e: SourceReferent Snapshot + Approval
  // Integrity v2)
  // =========================
  //
  // 絶対条件(このphaseの明示的設計判断、frozen): APPROVAL_SUBJECT_VERSION
  // は1のまま変更しない——sourceReferentは完全にadditive/optionalな
  // fieldであり、既存のv1 Approval(このfieldを一切持たない)の
  // canonical文字列表現には一切影響しない(Object.keys()は存在しない
  // keyを列挙しないため、stableStringify()の出力は既存v1 Approvalに
  // ついて1バイトも変わらない)。"ApprovalSubject v2"という設計提案を
  // 検討したが、既存のsubjectVersionによるハードな一致チェック
  // (verifyApprovalIntegrity()のstored.version !== APPROVAL_SUBJECT_VERSION)
  // を素朴にbumpすると、既存のpending/approved v1 Approval行が即座に
  // version_unsupportedへ倒れてしまう(このphaseの絶対条件: 既存v1
  // Approvalの継続動作を破壊しない)。バージョン番号自体を動かさず、
  // 「このfieldが存在するかどうか」だけで referent-aware かどうかを
  // 区別する——既存のApproval Subject field(canonicalInput等)が
  // 既にoptionalな設計を許容していないのと対称的に、ここでは新規
  // fieldそのものをoptionalにすることで後方互換性を型レベルで保証する。
  //
  // 絶対条件: これはProvider実行inputではない
  // (Gmail/Composio toolへは絶対に渡さない、core/tact-integration/
  // execution.tsのextractIntegrationActionFromApproval()が
  // IntegrationAction.inputとは完全に別のsibling fieldとして扱う)。
  sourceReferent?: SourceReferentSnapshot | null;

}

// =========================
// canonicalizeJsonValue
// =========================
//
// 任意のunknown値を、決定論的なcanonical JsonValueへ検証・変換する。
// 「意味が異なり得るなら別物として扱う」という設計方針(ARCH-P1a指示
// Step4)に基づき、以下は一切silent dropせず、明示的にfail closedする:
//   - bigint / function / symbol / Date(暗黙変換しない)
//   - 非finiteなnumber(NaN/Infinity/-Infinity、JSON表現不可能)
//   - objectのkeyにexplicitなundefined値が設定されている場合
//     (「keyが存在しない」こととは意味的に別物として扱う——
//     `"k" in obj`はtrueだが値がundefinedというケースを、単純な
//     JSON.stringify()の「undefinedを黙って落とす」挙動に頼らない)
//   - circular reference(Setで祖先を追跡し検出する)
//
// arrayの順序は保持する(意味を持つため並べ替えない)。objectのkey順は
// canonicalizeApprovalSubject()側でsortする(この関数自体は値の検証・
// 変換だけを行い、まだ文字列化はしない)。
export type CanonicalizeFailureReason =
  | "unsupported_type"
  | "explicit_undefined"
  | "circular_reference";

export type CanonicalizeResult =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: CanonicalizeFailureReason; path: string };

export function canonicalizeJsonValue(input: unknown): CanonicalizeResult {
  return canonicalizeInternal(input, new Set<object>(), "$");
}

function canonicalizeInternal(
  input: unknown,
  ancestors: Set<object>,
  path: string
): CanonicalizeResult {

  if (input === null) {
    return { ok: true, value: null };
  }

  const type = typeof input;

  if (type === "string" || type === "boolean") {
    return { ok: true, value: input as string | boolean };
  }

  if (type === "number") {

    if (!Number.isFinite(input as number)) {
      return { ok: false, reason: "unsupported_type", path };
    }

    return { ok: true, value: input as number };

  }

  // bigint/function/symbol/undefined(トップレベルまたは配列要素として
  // 現れた場合)はいずれもunsupported_typeとして拒否する。objectの
  // property値として現れたundefinedは、この関数へ到達する前に
  // walkObjectEntries()側でexplicit_undefinedとして区別する。
  if (type === "bigint" || type === "function" || type === "symbol" || type === "undefined") {
    return { ok: false, reason: "unsupported_type", path };
  }

  // Date等のruntime-specific objectを暗黙にstring化しない
  // (絶対条件、Step4)。JSON-safeなplain object/arrayだけを許容する。
  if (input instanceof Date) {
    return { ok: false, reason: "unsupported_type", path };
  }

  if (Array.isArray(input)) {

    if (ancestors.has(input)) {
      return { ok: false, reason: "circular_reference", path };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(input);

    const values: JsonValue[] = [];

    for (let i = 0; i < input.length; i++) {

      // 配列要素がexplicit undefinedの場合(例: [1, undefined, 3])も、
      // objectのkeyと同じ理由でexplicit_undefinedとして拒否する
      // (JSON.stringify()がnullへ暗黙変換する既定動作に頼らない)。
      if (!(i in input) || input[i] === undefined) {
        return { ok: false, reason: "explicit_undefined", path: `${path}[${i}]` };
      }

      const result = canonicalizeInternal(input[i], nextAncestors, `${path}[${i}]`);

      if (!result.ok) {
        return result;
      }

      values.push(result.value);

    }

    return { ok: true, value: values };

  }

  if (type === "object") {

    const obj = input as Record<string, unknown>;

    if (ancestors.has(obj)) {
      return { ok: false, reason: "circular_reference", path };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(obj);

    const result: { [key: string]: JsonValue } = {};

    // Object.keys()はenumerableな own propertyのみを列挙する
    // (prototype chain上の値を拾わない、決定論的挙動)。
    for (const key of Object.keys(obj)) {

      const value = obj[key];

      // 絶対条件(Step4): keyが存在し、かつ値がexplicit undefinedの
      // 場合、「keyが最初から存在しない」ことと同一視せず、明示的に
      // fail closedする。
      if (value === undefined) {
        return { ok: false, reason: "explicit_undefined", path: `${path}.${key}` };
      }

      const nested = canonicalizeInternal(value, nextAncestors, `${path}.${key}`);

      if (!nested.ok) {
        return nested;
      }

      result[key] = nested.value;

    }

    return { ok: true, value: result };

  }

  // 到達しない想定(typeofが返しうる値は上ですべて処理済み)だが、
  // 未知の型を黙って通さないための防御的fallback。
  return { ok: false, reason: "unsupported_type", path };

}

// =========================
// stableStringify
// =========================
//
// JsonValueを、object keyを再帰的にソートした決定論的な文字列へ
// 変換する。plain JSON.stringify()は挿入順序に依存するため使わない
// (絶対条件、Step4)——特にPostgreSQLのjsonb型はkey順序を保持する
// 保証が無いため、DBへ保存・再取得した後でも同じ文字列を再現できる
// ことが必須要件。
//
// 入力はcanonicalizeJsonValue()を通過済みのJsonValueであることを
// 前提とする(この関数自体は追加のvalidationを行わない、責務分離)。
function stableStringify(value: JsonValue): string {

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const sortedKeys = Object.keys(value).sort();

  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
  );

  return `{${entries.join(",")}}`;

}

// =========================
// buildApprovalSubject
// =========================
//
// 生のinput(Record<string, unknown>相当、Provider Adapterを一切
// 経由しないTACT canonical action.metadata.input)を検証・
// canonicalizeし、ApprovalSubjectを組み立てる。
//
// 絶対条件: この関数はDBアクセスを行わない。呼び出し元
// (将来のARCH-P1b、今回のARCH-P1aでは誰も呼ばない)が、既に解決済みの
// workId/taskId/service/operation/connectionId/riskClassSnapshotを
// 渡す。

export interface BuildApprovalSubjectParams {

  workId: string;

  taskId: string | null;

  service: string;

  operation: string;

  // canonical action.metadata.input相当の生値。JSON-safeでない値が
  // 含まれる場合は安全にfail closedする(silent dropしない)。
  input: unknown;

  connectionId: string | null;

  riskClassSnapshot: ApprovalRiskClassSnapshot | null;

  // REF-P1e: 完全にoptional。呼び出し元がresolved/pinned referentを
  // 持つ場合のみ渡す——省略/null時はcanonical subject自体に
  // sourceReferent keyが一切現れない(v1 Approvalと同一の
  // canonical文字列表現、後方互換性)。
  sourceReferent?: SourceReferentSnapshot | null;

}

export type BuildApprovalSubjectResult =
  | { ok: true; subject: ApprovalSubject }
  | { ok: false; reason: CanonicalizeFailureReason; path: string };

export function buildApprovalSubject(
  params: BuildApprovalSubjectParams
): BuildApprovalSubjectResult {

  const canonicalized = canonicalizeJsonValue(params.input);

  if (!canonicalized.ok) {
    return { ok: false, reason: canonicalized.reason, path: canonicalized.path };
  }

  return {

    ok: true,

    subject: {
      subjectVersion: APPROVAL_SUBJECT_VERSION,
      workId: params.workId,
      taskId: params.taskId,
      service: params.service,
      operation: params.operation,
      canonicalInput: canonicalized.value,
      connectionId: params.connectionId,
      riskClassSnapshot: params.riskClassSnapshot,
      // 絶対条件: keyそのものを省略する(explicit undefinedを埋め込ま
      // ない)——stableStringify()はObject.keys()ベースであり、
      // 存在しないkeyはv1 Approvalと同じ振る舞いを保つ。
      ...(params.sourceReferent ? { sourceReferent: params.sourceReferent } : {}),
    },

  };

}

// =========================
// canonicalizeApprovalSubject / hashApprovalSubject
// =========================
//
// ApprovalSubject全体(subjectVersionを含む——将来subjectの形自体が
// 変わった場合、versionが異なれば別のhashになる)を決定論的な文字列・
// SHA-256 hex digestへ変換する。
//
// 絶対条件: subject_json列(jsonb)の生byte表現を直接hash材料にしない
// ——PostgreSQLのjsonb型はkey順序を保持する保証が無いため、DBへの
// 保存・再取得を経てもこの関数を再度通せば同じ文字列・同じhashが
// 再現できる、という性質こそがこの関数の存在意義である。

export function canonicalizeApprovalSubject(subject: ApprovalSubject): string {

  // ApprovalSubjectは既にJSON-safeな型として定義されているため
  // (buildApprovalSubject()がcanonicalizeJsonValue()を通した結果しか
  // 生成しない)、ここでは型アサーションのみ行いvalidationを重複させ
  // ない。ただしtest/呼び出し元が手組みしたsubjectに対しても安全に
  // 動作するよう、stableStringify()自体は入力の形を信用して処理する
  // (このfile内で完結する既知の型のみを扱うため、追加の防御的
  // validationは責務過剰と判断)。
  const asJsonValue = subject as unknown as JsonValue;

  return stableStringify(asJsonValue);

}

export function hashApprovalSubject(canonicalJson: string): string {

  // Node標準crypto、既存core/tact-bot/adapters/slack/
  // verifySlackSignature.tsと同じnode:crypto利用パターン(新規
  // dependency追加なし)。digest("hex")は常に小文字16進文字列を返す
  // (Node組み込み挙動、repo内で一貫させるための追加変換は不要)。
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");

}

// =========================
// verifyApprovalIntegrity (ARCH-P1a: 純粋なsubject比較/hash
// validationのみ)
// =========================
//
// 絶対条件(ARCH-P1a指示、最重要): この関数はDBからApprovalを読む
// 処理や、core/tact-integration/execution.tsのexecuteApprovedIntegrationAction()
// への接続を一切行わない。呼び出し元(将来のARCH-P1c)が、既に取得済みの
// stored subject(DB row由来)とcurrent subject(実行直前に再構築した
// もの)を渡すだけの、純粋な比較関数。
//
// この型のresultは、ARCH-P1cで実装されるexecution outcome
// (IntegrationActionExecutionOutcomeへ追加される予定のapproval_
// subject_changed)とは意図的に別物である(approval-integrity.md:
// 「P1cのexecution outcomeとは別物にする」)——このfileはexecution
// boundaryのvocabularyを一切知らない。

export interface StoredApprovalSubject {

  // DB(tact_approvals.subject_version)の値。null = 未capture
  // (ARCH-P1a時点の全既存行、またはARCH-P1b以前に作成されたApproval)。
  version: number | null;

  // DB(tact_approvals.subject_json)の値。unknown型で受け取り、
  // この関数自身がruntime validationを行う(呼び出し元のDB層を
  // 信用しない、fail closed)。
  json: unknown;

  // DB(tact_approvals.subject_hash)の値。
  hash: string | null;

}

export type ApprovalIntegrityCheck =
  | { result: "match" }
  // stored.version(DB列)がAPPROVAL_SUBJECT_VERSIONと一致しない、
  // またはnull(未capture)。
  | { result: "version_unsupported" }
  // stored.jsonがApprovalSubjectとして解釈できない形、または
  // stored.json内部のsubjectVersionがstored.version(DB列)と食い違う
  // (single source of truthの不整合、data corruption signal)。
  | { result: "stored_subject_invalid" }
  // stored.jsonをcanonicalize()した結果がstored.hashと一致しない
  // (stored dataそのものの内部整合性エラー)。
  | { result: "hash_mismatch" }
  // stored subjectとcurrent subjectのcanonical文字列が異なる
  // (実際にcontentがずれている、本来検出したい主要ケース)。
  // mismatchedFieldsは内部診断専用——Bot/user向けmessageへは絶対に
  // 生のまま出さない(approval-integrity.md Security Invariant 12)。
  | { result: "subject_mismatch"; mismatchedFields: string[] };

const APPROVAL_SUBJECT_FIELD_NAMES: readonly (keyof ApprovalSubject)[] = [
  "subjectVersion",
  "workId",
  "taskId",
  "service",
  "operation",
  "canonicalInput",
  "connectionId",
  "riskClassSnapshot",
  "sourceReferent",
];

const RISK_CLASS_SNAPSHOT_VALUES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "destructive",
]);

// =========================
// parseSourceReferentSnapshot (REF-P1e)
// =========================
//
// unknown値をSourceReferentSnapshotとして厳密にvalidationする。
// stored subject側・execution-time再構築側(core/tact-integration/
// execution.ts)の両方から再利用する、唯一のvalidation実装
// (絶対条件: 検証ロジックを複製しない)。絶対条件: body・snippet・
// 生provider payload・Composio ID・OAuth情報等、frozen shapeに無い
// fieldを一切許容しない(余分なfieldがあっても無視するだけで、
// 不正な形にはしない——余剰fieldを許容してもそれ自体が悪用可能な
// 経路を作らないため、狭すぎる検証よりexact-shape要求を優先しない)。
export function parseSourceReferentSnapshot(value: unknown): SourceReferentSnapshot | undefined {

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.sourceType !== "gmail") {
    return undefined;
  }

  if (typeof candidate.sourceMessageRef !== "string" || candidate.sourceMessageRef.length === 0) {
    return undefined;
  }

  if (typeof candidate.sender !== "string" || candidate.sender.length === 0) {
    return undefined;
  }

  if (typeof candidate.normalizedSubject !== "string" || candidate.normalizedSubject.length === 0) {
    return undefined;
  }

  if (candidate.threadRef !== undefined && typeof candidate.threadRef !== "string") {
    return undefined;
  }

  if (candidate.observedAt !== undefined && typeof candidate.observedAt !== "string") {
    return undefined;
  }

  return {
    sourceType: "gmail",
    sourceMessageRef: candidate.sourceMessageRef,
    sender: candidate.sender,
    normalizedSubject: candidate.normalizedSubject,
    ...(typeof candidate.threadRef === "string" ? { threadRef: candidate.threadRef } : {}),
    ...(typeof candidate.observedAt === "string" ? { observedAt: candidate.observedAt } : {}),
  };

}

// stored.json(unknown)をApprovalSubjectとして厳密にvalidationする。
// 型を強制せず、実際の値の形を1つ1つ確認する(呼び出し元DB層を
// 信用しない、絶対条件)。
export function parseStoredApprovalSubject(json: unknown): ApprovalSubject | undefined {

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return undefined;
  }

  const candidate = json as Record<string, unknown>;

  if (typeof candidate.subjectVersion !== "number") {
    return undefined;
  }

  if (typeof candidate.workId !== "string" || candidate.workId.length === 0) {
    return undefined;
  }

  if (candidate.taskId !== null && typeof candidate.taskId !== "string") {
    return undefined;
  }

  if (typeof candidate.service !== "string" || candidate.service.length === 0) {
    return undefined;
  }

  if (typeof candidate.operation !== "string" || candidate.operation.length === 0) {
    return undefined;
  }

  const canonicalInputResult = canonicalizeJsonValue(candidate.canonicalInput);

  if (!canonicalInputResult.ok) {
    return undefined;
  }

  if (candidate.connectionId !== null && typeof candidate.connectionId !== "string") {
    return undefined;
  }

  if (
    candidate.riskClassSnapshot !== null &&
    (typeof candidate.riskClassSnapshot !== "string" ||
      !RISK_CLASS_SNAPSHOT_VALUES.has(candidate.riskClassSnapshot))
  ) {
    return undefined;
  }

  // REF-P1e: keyが存在しない(v1 Approval)場合はsourceReferent無しの
  // まま許容する。keyが存在するのに不正な形の場合は、stored subject
  // 全体を破損データとしてfail closedする(絶対条件: 永続化された
  // 値は本来buildApprovalSubject()が正しい形でしか書き込まないはず
  // ——ここでの不整合は改ざん/破損の兆候として扱う)。
  let sourceReferent: SourceReferentSnapshot | undefined;

  if ("sourceReferent" in candidate && candidate.sourceReferent !== null && candidate.sourceReferent !== undefined) {
    const parsed = parseSourceReferentSnapshot(candidate.sourceReferent);
    if (!parsed) {
      return undefined;
    }
    sourceReferent = parsed;
  }

  return {
    subjectVersion: candidate.subjectVersion,
    workId: candidate.workId,
    taskId: candidate.taskId as string | null,
    service: candidate.service,
    operation: candidate.operation,
    canonicalInput: canonicalInputResult.value,
    connectionId: candidate.connectionId as string | null,
    riskClassSnapshot: candidate.riskClassSnapshot as ApprovalRiskClassSnapshot | null,
    ...(sourceReferent ? { sourceReferent } : {}),
  };

}

function findMismatchedFields(stored: ApprovalSubject, current: ApprovalSubject): string[] {

  return APPROVAL_SUBJECT_FIELD_NAMES.filter((field) => {
    // REF-P1e: sourceReferentはoptional(v1 Approval/非referent-aware
    // actionではundefined)。stableStringify()はObject.keys()前提の
    // 実装であり、undefinedを直接渡すと例外になる——「無い」を
    // nullと同一視して安全に比較する(既存の必須field群は元々
    // T | nullでありundefinedを取らないため、この正規化は無害)。
    const storedValue = (stored[field] ?? null) as JsonValue;
    const currentValue = (current[field] ?? null) as JsonValue;
    return stableStringify(storedValue) !== stableStringify(currentValue);
  });

}

export function verifyApprovalIntegrity(
  stored: StoredApprovalSubject,
  currentSubject: ApprovalSubject
): ApprovalIntegrityCheck {

  if (stored.version === null || stored.version !== APPROVAL_SUBJECT_VERSION) {
    return { result: "version_unsupported" };
  }

  const storedSubject = parseStoredApprovalSubject(stored.json);

  if (!storedSubject) {
    return { result: "stored_subject_invalid" };
  }

  // single source of truthの整合性確認(このfile冒頭のコメント参照):
  // DB列(stored.version)とsubject_json内部のsubjectVersionが食い違う
  // 場合、どちらを信用すべきか判断できないため、安全側で「stored
  // subject自体が壊れている」として扱う。
  if (storedSubject.subjectVersion !== stored.version) {
    return { result: "stored_subject_invalid" };
  }

  const storedCanonicalJson = canonicalizeApprovalSubject(storedSubject);

  if (stored.hash === null || hashApprovalSubject(storedCanonicalJson) !== stored.hash) {
    return { result: "hash_mismatch" };
  }

  const currentCanonicalJson = canonicalizeApprovalSubject(currentSubject);

  if (storedCanonicalJson === currentCanonicalJson) {
    return { result: "match" };
  }

  return {
    result: "subject_mismatch",
    mismatchedFields: findMismatchedFields(storedSubject, currentSubject),
  };

}
