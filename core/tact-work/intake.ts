import { createWork, getWork } from "./store";
import type { Work, ActorReference } from "./types";

// =========================
// TACT Work — Work Intake Boundary (Architecture Migration Phase B2)
// =========================
//
// 目的: Web/Bot/将来のAPI/system eventのどのInterfaceから依頼が
// 入っても、同じ契約(WorkIntakeRequest)でWorkを解決・作成できる
// ようにする。ARCH-R2 Section11の目標経路
// (Interface → Conversation → Work Intake → Work → ...)の
// 「Work Intake」に相当する。
//
// 絶対条件(Phase B2指示): 「Conversationが存在しないとWorkを作れない」
// 設計を禁止する。conversationIdはnullableであり、将来scheduler/
// system event/APIから直接Workを作れる構造を維持する。
//
// 巨大なInterfaceにしない: このモジュールはtact_conversationsの
// schema(work_id列等)を一切知らない。「既存Workを再利用するか、
// 新規作成するか」の判断材料(existingWorkId)は、呼び出し元
// (例: core/tact-conversation/orchestration.ts)が自分自身の既存
// データ(conversation.workId)から渡す——Work Intake自身が
// Conversationテーブルへ問い合わせることはしない(モジュール間の
// 一方向依存を保つ)。

export type WorkIntakeSource = "web" | "bot" | "api" | "system";

export interface WorkIntakeRequest {

  userId: string;

  // このWorkを実際に要求した主体。Bot経由であっても、BOT-P2.5で
  // 確立した原則通り、外部Channelのexternal actor idではなく
  // server側で解決済みのtactUserId(kind:"user")を渡すこと。
  requestedByActor: ActorReference;

  content: string;

  source: WorkIntakeSource;

  // 将来scheduler/system event/APIから直接Workを作る場合はnull/
  // 省略でよい(絶対条件: Conversation無しでWorkを作れない設計に
  // しない)。
  conversationId?: string | null;

  // 呼び出し元が既に把握している、再利用候補のWork id(例:
  // Conversation.workId)。指定が無い、または指定されたWorkが
  // このuserから見て解決できない(存在しない/他user所有)場合は、
  // 新しいWorkを作成する——「他user Work linkは再利用されない」
  // という絶対条件は、Work Store自体の既存ownership defense
  // (core/tact-work/store.tsのgetWork())にそのまま従う形で満たす。
  existingWorkId?: string | null;

  metadata?: Record<string, unknown> | null;

}

const WORK_TITLE_MAX_LENGTH = 60;

function deriveWorkTitle(content: string): string | null {

  const trimmed = content.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length > WORK_TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, WORK_TITLE_MAX_LENGTH)}...`
    : trimmed;

}

// =========================
// resolveWork
// =========================
//
// テスト容易性のため、実際のStore呼び出し(getWork/createWork)を
// Constructor/Parameter Injectionで差し替え可能にする(既定値は
// core/tact-work/store.tsの実関数。core/tact-bot/connector/
// conversationConnector.tsと同じDIパターン)。実Supabaseに接続せず、
// 「existingWorkIdが他user所有で解決できない場合は新規作成する」等の
// 分岐ロジックを検証できる。

export interface ResolveWorkDeps {

  getWork: typeof getWork;

  createWork: typeof createWork;

}

// existingWorkIdが指定され、かつrequest.userId本人が所有している
// 場合はそのWorkをそのまま返す(1 Conversation → 1 active Workの
// 単純運用)。それ以外(未指定・解決不能)の場合は新しいWorkを作成する。
export async function resolveWork(
  request: WorkIntakeRequest,
  accessToken: string,
  deps: ResolveWorkDeps = { getWork, createWork }
): Promise<Work> {

  if (request.existingWorkId) {

    const existing = await deps.getWork(request.existingWorkId, request.userId, accessToken);

    if (existing) {
      return existing;
    }

    // stale/wrong link(存在しない、または他user所有)。安全側として
    // 新規Workを作成する——他userのWorkを実行に使うことは絶対に
    // しない(core/tact-bot/connector/conversationConnector.tsの
    // stale link fallbackと同じ考え方)。

  }

  return deps.createWork(
    {
      userId: request.userId,
      createdByActorKind: request.requestedByActor.kind,
      createdByActorId: request.requestedByActor.id,
      primaryConversationId: request.conversationId ?? null,
      title: deriveWorkTitle(request.content),
      metadata: {
        source: request.source,
        ...(request.metadata ?? {}),
      },
    },
    accessToken
  );

}
