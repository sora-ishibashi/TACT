// =========================
// TACT Bot — Trusted External Event Ingest Boundary (EVENT-P1d Phase3)
// =========================
//
// core/tact-bot/execution/trustedApprovalDecision.ts・
// trustedConversationTurn.tsと同じ設計: 「server-side verified external
// identity(tactUserId) → trusted server-side execution」という認証
// モードを、canonical Event層(core/tact-event/)への到達についても
// 明示的に表現する境界。
//
//   Bot:  server-side verified external identity(tactUserId、Slack
//         signature検証 + supabaseBotIdentityResolver解決済み)
//           → ingestTrustedExternalEvent() [ここ、pre-ACK同期実行]
//             → core/tact-event/のingestExternalEvent()
//                [canonical intake boundary、EVENT-P1b。dedup済みの
//                durable ExternalEvent受領をACK前に確定させる]
//           → continueTrustedExternalEventArrival() [ここ、post-ACK
//             background実行]
//             → core/tact-event/のprocessExternalEventArrival()
//                [canonical match+resume boundary、EVENT-P1c。
//                ingestExternalEvent()を再度呼ぶが、直前のingestと
//                同じ(source, externalEventId)であるため既存のdedup
//                (event_duplicate、既存行を返すだけでmutateしない)
//                に必ず落ちる——match→resumeを別に手で組み立てず、
//                既存canonical pipelineをそのまま再利用するための
//                意図的な再呼び出し]
//
// tactUserIdはこのfile自身が解決しない——呼び出し元(Slack adapter)が
// 既にsupabaseBotIdentityResolver等で検証済みの値を渡すことを保証する
// (trustedApprovalDecision.ts/trustedConversationTurn.tsと同じ役割
// 分担、この境界は再検証しない)。provider(Slack)由来の生の値を
// tactUserIdとしてそのまま受け取ることは絶対に無い、という契約は
// 呼び出し元(core/tact-bot/adapters/slack/)側で保証される。
//
// service role keyはこのfile(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない(既存trusted execution boundaryと同じ絶対条件)。
// このfileはSlack固有のparsing/署名検証を一切持たない
// (trusted execution adapterであってprovider parserではない)。

import {
  ingestExternalEvent as defaultIngestExternalEvent,
  processExternalEventArrival as defaultProcessExternalEventArrival,
  type EventIngestOutcome,
  type ExternalEventArrivalOutcome,
  type NormalizedExternalEventInput,
} from "../../tact-event";
import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../database/supabaseServiceRole";

// Web(将来のcanonical Event Provider API、今回のscope外)との意図的な
// 違い: accessTokenを受け取らない。tactUserIdは呼び出し元が既に検証
// 済みの値であることを前提とする。
export interface TrustedExternalEventParams {

  tactUserId: string;

  source: string;

  eventType: string;

  externalEventId: string;

  subjectRef: string;

  occurredAt?: string | null;

  // Section「normalizedPayload is an explicit allowlist」——このfile
  // 自身は中身を検証しない。呼び出し元(Slack adapter)がallowlist済みの
  // 値だけを渡す責務を負う(ingestExternalEvent()自身のvalidateが
  // 型レベルの妥当性のみ再確認する)。
  normalizedPayload?: Record<string, unknown>;

}

// unit testがlive Supabaseへ到達しないよう、この境界が呼ぶ2つの
// canonical functionだけを差し替え可能にする最小のDI seam
// (trustedApprovalDecision.tsと同じ方針、defaultは既存canonical
// functionそのまま)。
export interface TrustedExternalEventIngestDeps {

  ingestExternalEvent: typeof defaultIngestExternalEvent;

  processExternalEventArrival: typeof defaultProcessExternalEventArrival;

  // このtest環境にはSUPABASE_SERVICE_ROLE_KEYが設定されていないため
  // (trustedApprovalDecision.ts/trustedConversationTurn.tsと同じ既存
  // 事情)、上記のdepsをfake実装へ差し替えるだけでは分岐へ到達できない。
  // getServiceRoleKey自体もこのDI seamへ含める(production defaultは
  // 既存のgetServiceRoleKey()のまま、挙動変更なし)。
  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

const defaultDeps: TrustedExternalEventIngestDeps = {
  ingestExternalEvent: defaultIngestExternalEvent,
  processExternalEventArrival: defaultProcessExternalEventArrival,
  getServiceRoleKey: defaultGetServiceRoleKey,
};

function buildNormalizedInput(params: TrustedExternalEventParams): NormalizedExternalEventInput {

  return {
    userId: params.tactUserId,
    source: params.source,
    eventType: params.eventType,
    externalEventId: params.externalEventId,
    subjectRef: params.subjectRef,
    occurredAt: params.occurredAt,
    normalizedPayload: params.normalizedPayload,
  };

}

export type IngestTrustedExternalEventResult =
  | { ok: true; outcome: EventIngestOutcome }
  | { ok: false; error: "trusted_execution_not_configured" };

// pre-ACK同期実行(Section「durable canonical ExternalEvent ingest」)。
// service role keyが未設定の場合、DBへは一切アクセスせず安全に
// fallbackする(既存trusted execution boundaryと同じパターン)——
// 呼び出し元(Slack adapter)はok:falseを、mapped userに対する
// 必須ingestが行えなかった場合のfail-closed 5xxへつなげる。
export async function ingestTrustedExternalEvent(
  params: TrustedExternalEventParams,
  deps: TrustedExternalEventIngestDeps = defaultDeps
): Promise<IngestTrustedExternalEventResult> {

  const trustedExecutionCredential = deps.getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { ok: false, error: "trusted_execution_not_configured" };
  }

  const outcome = await deps.ingestExternalEvent(
    buildNormalizedInput(params),
    trustedExecutionCredential
  );

  return { ok: true, outcome };

}

export type ContinueTrustedExternalEventArrivalResult =
  | { ok: true; outcome: ExternalEventArrivalOutcome }
  | { ok: false; error: "trusted_execution_not_configured" };

// post-ACK background実行(Section「background EVENT match/resume」)。
// EVENT-P1d Phase1/2: trustedExecutionCredential(service role key)で
// 接続するため、RPC内のcurrent_user = 'service_role'判定を満たす——
// ここで渡すtactUserIdがp_trusted_user_idとしてのみ効く(RPC自身が、
// service_role接続でない限りこの値を構造的に無視する)。
export async function continueTrustedExternalEventArrival(
  params: TrustedExternalEventParams,
  deps: TrustedExternalEventIngestDeps = defaultDeps
): Promise<ContinueTrustedExternalEventArrivalResult> {

  const trustedExecutionCredential = deps.getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { ok: false, error: "trusted_execution_not_configured" };
  }

  const outcome = await deps.processExternalEventArrival(
    buildNormalizedInput(params),
    trustedExecutionCredential,
    undefined,
    params.tactUserId
  );

  return { ok: true, outcome };

}
