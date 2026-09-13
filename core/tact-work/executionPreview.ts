import type { SourceReferentSnapshot } from "../tact-referent/types";
import { parseSourceReferentSnapshot } from "./approvalIntegrity";
import { buildGmailSendPreview } from "./gmailExecutionPreview";
import { buildSlackSendPreview } from "./slackExecutionPreview";

// =========================
// TACT Work — Canonical Execution Preview (APPROVAL-P2)
// =========================
//
// 目的(Product Principle): Approvalを「承認/却下ボタンだけ」から
// 「何が・どこで・何を・誰に対して・外部影響を伴うかどうか・
// 取り消せるかどうか」を承認前に示すCanonical Execution Previewへ
// 拡張する。ProviderやOperationが増えても、TACT Approval core
// (このfile・core/tact-bot/approval.ts・Slack renderer)自体は
// 一切変更する必要がない設計にする。
//
// 絶対条件(CORE SAFETY PRINCIPLE、最重要): Previewは常に「既にfreeze
// 済みのcanonical Action」から決定論的に導出するだけであり、独立した
// 自然言語要約を別途作らない。Frozen Action → Approval Integrity /
// Execution Preview / Provider Executionの3つが同じsource of truthを
// 共有する(このfileは表示専用の"projection"であり、Actionの代替表現を
// 新たに持たない)。
//
// 絶対条件(NO PROVIDER PAYLOAD IN PREVIEW TYPE): ExecutionPreviewは
// 表示に安全なcanonical metadataのみを持つ——生provider payload・
// OAuth token・connection secret・Composio tool引数・Gmail生API
// message・Slack生block objectのいずれも一切含めない。
//
// 絶対条件(NO LLM): Preview生成は決定論的なpure関数のみで行う。LLM・
// 外部API呼び出し・provider network callは一切行わない
// (SIDE-EFFECT FREE PREVIEW)。
//
// 絶対条件(PREVIEW / ACTION MISMATCH、fail closed): 対応する
// builderが登録されていないservice.operationに対しては、undefinedを
// 返す——呼び出し元(core/tact-bot/approval.ts)はこれを
// 「Approvalを安全に表示できない」ことの明示的signalとして扱い、
// 汎用的な「この操作を実行します」のような当たり障りのない文言で
// 誤魔化して承認だけを許可しない(呼び出し元がbuttonsを出さない、
// 等の安全側判断を行う)。

// =========================
// ExecutionPreview (canonical, presentation-safe)
// =========================

export interface ExecutionPreviewField {

  label: string;

  value: string;

  // "sensitive"は将来のmasking等の表示都合のための分類のみ
  // (このphaseでは全fieldをそのまま表示する、絶対条件Section「EXACT
  // BODY」——本文を要約・truncateしない)。
  sensitivity?: "normal" | "sensitive";

}

export interface ExecutionPreviewChange {

  field: string;

  before?: string;

  after?: string;

}

export interface ExecutionPreviewTarget {

  label?: string;

  accountLabel?: string;

  objectLabel?: string;

}

export interface ExecutionPreviewEffects {

  externalCommunication: boolean;

  externalWrite: boolean;

  notification: boolean;

  destructive: boolean;

  // 絶対条件(IRREVERSIBILITY定義): 「TACTがexecution後に外部状態を
  // 自動的に復元できない」ことを意味するだけであり、Provider自体に
  // undo機能が存在しないと断定するものではない(TACTが制御できない
  // Provider機能を勝手に約束しない)。
  irreversible: boolean;

}

export const EXECUTION_PREVIEW_VERSION = 1;

export interface ExecutionPreview {

  version: typeof EXECUTION_PREVIEW_VERSION;

  actionLabel: string;

  service: string;

  operation: string;

  target?: ExecutionPreviewTarget;

  summary: string;

  fields: readonly ExecutionPreviewField[];

  // WORK-P2(複数Action合成Approval)はこのphaseのscope外——このfield
  // 自体は「1つのActionが持つ構造化変更」のためだけに存在し、複数
  // Actionを束ねる仕組みではない(絶対条件NO MULTI-ACTION PREVIEW YET)。
  changes?: readonly ExecutionPreviewChange[];

  effects: ExecutionPreviewEffects;

  warnings?: readonly string[];

}

// =========================
// ExecutionPreviewBuilder registry (REGISTRY / ADAPTER DESIGN)
// =========================
//
// 絶対条件: Approval core(このfile・core/tact-bot/approval.ts・Slack
// renderer)はservice/operationごとのif/elseを持たない——`service.
// operation`というkeyでbuilderをlookupするだけの単純なstatic map。
// 新しいProvider/Operationを追加する場合、この1箇所へ1行追加する
// だけでよい(PROVIDER ADDITION CONTRACT参照)。
//
// 絶対条件(このfile自身の純度): builderはcanonical Action(service/
// operation/input、Approval.payload.action.metadataからここまでに
// 既に安全に抽出済みの値)とoptionalなcontext(現状sourceReferentのみ)
// だけを受け取る——DB/Provider/Connection secretのいずれにも一切
// アクセスしない。

export interface ExecutionPreviewContext {

  // REF-P1e/P1fで確立済みのSourceReferentSnapshot(既にbody/snippet/
  // 内部IDを持たない安全なcanonical type)をそのまま再利用する。
  sourceReferent?: SourceReferentSnapshot;

}

export type ExecutionPreviewBuilder = (
  action: { service: string; operation: string; input: Record<string, unknown> },
  context?: ExecutionPreviewContext
) => ExecutionPreview | undefined;

// PROVIDER ADDITION CONTRACT(このphaseの明示的要求、大きなdocを
// 作らない代わりにこのコメント+testで契約を表す):
// 新しいprotected Action(service.operation)を追加する場合、以下が
// 揃って初めて「Approval-ready」になる。
//   1. canonical input(core/tact-integration/types.ts)
//   2. Policy(core/tact-integration/policy.tsのPOLICY_ALLOWLIST)
//   3. Execution Preview builder(このmapへの登録)
//   4. Provider mapper(core/tact-integration/providers/配下)
// このいずれか(特に3)が欠けている場合、buildExecutionPreview()は
// undefinedを返し、Approval UIはfail closed(承認ボタンを出さない)
// になる——「Preview builderが無い=承認可能扱いにしない」という
// 構造的な保証(tests/tact/work/executionPreview.test.ts参照)。
const EXECUTION_PREVIEW_BUILDERS: Readonly<Record<string, ExecutionPreviewBuilder>> = {
  "gmail.send_message": buildGmailSendPreview,
  "slack.send_message": buildSlackSendPreview,
};

export function buildExecutionPreview(
  action: { service: string; operation: string; input: Record<string, unknown> },
  context?: ExecutionPreviewContext
): ExecutionPreview | undefined {

  const builder = EXECUTION_PREVIEW_BUILDERS[`${action.service}.${action.operation}`];

  if (!builder) {
    return undefined;
  }

  return builder(action, context);

}

// =========================
// buildExecutionPreviewFromApprovalPayload (APPROVAL PERSISTENCE)
// =========================
//
// 絶対条件(APPROVAL PERSISTENCE、このphaseの明示的判断): Previewを
// 別途永続化しない——frozen Approval.payload(Approval Integrityが
// 既に検証するsource of truth)から、renderのたびに決定論的に
// 再構築するだけにとどめる(Action/Preview driftを構造的に防ぎ、
// 新しい可変stateを増やさない)。
//
// 絶対条件(BACKWARD COMPATIBILITY): 新しいDB migrationは不要
// (Approval.payload.action.metadataの形はREF-P1e/P1fから変わって
// いない)。sourceReferentを持たない旧Approval(v1)でも、
// service/operation/inputさえ復元できればpreviewは安全に作れる
// (sourceReferent由来のfieldが無いだけ)。
//
// 絶対条件(PREVIEW / ACTION MISMATCH): service/operation/inputの
// いずれかが復元できない、またはbuilderが登録されていない場合は
// 例外を投げずundefinedを返す(呼び出し元が安全側のUIへfall back
// する)。
export function buildExecutionPreviewFromApprovalPayload(
  payload: Record<string, unknown>
): ExecutionPreview | undefined {

  const action = payload.action;

  if (!action || typeof action !== "object") {
    return undefined;
  }

  const metadata = (action as { metadata?: unknown }).metadata;

  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;

  const service = typeof record.service === "string" ? record.service : undefined;
  const operation = typeof record.operation === "string" ? record.operation : undefined;
  const input =
    record.input && typeof record.input === "object"
      ? (record.input as Record<string, unknown>)
      : undefined;

  if (!service || !operation || !input) {
    return undefined;
  }

  // 絶対条件(REF-P1e継承): sourceReferentは「Approval作成時に
  // buildApprovalSubject()を通過済みの正しい形」であるはずだが、
  // raw jsonbからの再抽出は型検証のみで安全に行う(DB層を信用しない、
  // approvalIntegrity.tsのparseStoredApprovalSubject()と同じ方針)。
  const sourceReferent = parseSourceReferentSnapshot(record.sourceReferent);

  return buildExecutionPreview(
    { service, operation, input },
    sourceReferent ? { sourceReferent } : undefined
  );

}
