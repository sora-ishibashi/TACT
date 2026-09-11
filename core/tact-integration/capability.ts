import { extractSlackSendIntent } from "../tact-intent/ruleRouter";
import { evaluatePolicyDecision } from "./policy";
import type { CapabilityInvocationRequest, CapabilityInvocationResult } from "../tact-orchestrator/types";

const GMAIL_SERVICE = "gmail";
const GMAIL_SEARCH_MAX_QUERY_LENGTH = 200;
const GMAIL_SEARCH_DEFAULT_MAX_RESULTS = 10;
const NOTION_SERVICE = "notion";
const NOTION_SEARCH_DEFAULT_MAX_RESULTS = 10;

// LIVE-1A Gmail Query Extraction Fix: 「」『』""''のいずれかで囲まれた
// 引用部分を、Slack send_message抽出(SLACK_QUOTED_TEXT_PATTERN、
// core/tact-intent/ruleRouter.ts)と同じ4種類の引用符スタイルで認識する。
// globalフラグで全出現を集める理由: 引用が0個(通常の自然文)・1個
// (意図が明確)・2個以上(どちらを検索語とすべきか曖昧)を区別するため
// ——2個以上の場合は推測で1つを選ばず、下のfallback抽出へ委ねる
// (絶対条件、Accuracy > Coverage)。
// `.*?`(0文字以上)を使う理由: 「」のような空の引用も1件の引用として
// 検出できるようにするため(下のextractGmailSearchQuery()が「引用が
// 明示的に1個だけ存在するが中身が空」というケースをfail closedとして
// 扱えるようにする——0文字にマッチしない`.+?`だと「」自体が
// マッチせず、引用0個の入力と区別が付かなくなってしまう)。
const GMAIL_QUERY_QUOTE_PATTERNS: readonly RegExp[] = [
  /「(.*?)」/gu,
  /『(.*?)』/gu,
  /"(.*?)"/gu,
  /'(.*?)'/gu,
];

// 空文字の引用も(trimmed)そのまま含めて返す——空/非空の判定は
// 呼び出し元(extractGmailSearchQuery())の責務とする。
function extractQuotedPhrases(input: string): string[] {

  const phrases: string[] = [];

  for (const pattern of GMAIL_QUERY_QUOTE_PATTERNS) {

    for (const match of input.matchAll(pattern)) {
      phrases.push(match[1].trim());
    }

  }

  return phrases;

}

// LIVE-1A Gmail Query Extraction Fix(root cause): 以前は`gmail|メール|mail`
// を出現位置に関わらず無条件に全削除していたため、「Gmailから」の
// "Gmail"だけを取り除いた後に残る格助詞「から/で」が最終的なqueryへ
// そのまま残っていた(実LIVE障害: "Gmailから「X」を検索して" →
// Composioへ渡ったqueryが"から「X」"になっていた)。加えて、この
// 無条件削除は「田中さんのメール」のような、メールという語自体が
// 検索対象の一部である正当な内容まで壊していた。
//
// 修正方針: 英語表記の"gmail"/"mail"が明示的に含まれる入力
// (例: "Gmailから")では、その語(+直後に連続する「から/で」だけを
// 1つの単位として除去し、それ以外の場所に出現する「メール」は内容の
// 一部として残す。英語表記が無い入力(例: "A社との最近のメールを
// 確認して")では、「メール」自体が話題を示す唯一の手がかりのため、
// 既存通り全出現を除去する(既存Regression Testが要求する挙動を
// 変更しない)。
function stripGmailTriggerWord(input: string): string {

  const hasExplicitEnglishTrigger = /gmail|mail/i.test(input);

  if (hasExplicitEnglishTrigger) {
    return input.replace(/(?:gmail|mail)(から|で)?/gi, " ");
  }

  return input.replace(/メール/g, " ");

}

// The rule router decides that this is Gmail search.  This helper only
// derives the provider-neutral search expression and never accepts a raw
// provider payload.
export function extractGmailSearchQuery(input: string): string | undefined {

  // LIVE-1A Gmail Query Extraction Fix: 引用部分が明確に1個だけ存在する
  // 場合は、それを最優先でcanonical queryとして採用する(絶対条件:
  // "Gmailから「X」を検索して" → "X"、から/Gmail/引用符/を検索して等の
  // 会話上のnoiseを一切含めない)。空文字・上限超過の引用はここで
  // fail closedする(下のfallback抽出へ迂回させない——引用符で明示的に
  // 区切られた意図を無視して別解釈するのは、Accuracy > Coverageの
  // 方針に反する)。
  const quotedPhrases = extractQuotedPhrases(input);

  if (quotedPhrases.length === 1) {

    const quoted = quotedPhrases[0];

    return quoted.length > 0 && quoted.length <= GMAIL_SEARCH_MAX_QUERY_LENGTH
      ? quoted
      : undefined;

  }

  // Fallback(引用が0個、または2個以上で曖昧な場合): 既存の
  // 「話題語+依頼動詞の活用形を機械的に取り除く」cleanupを踏襲するが、
  // 依頼動詞の除去は文末anchor(`$`)を追加し、文中に偶然「検索/探し」
  // 等を含む正当な内容まで巻き込まないようにする(絶対条件、最小修正)。
  const query = stripGmailTriggerWord(input)
    .replace(/(を|で)?(検索|探し|確認|見せ|読み)[^。、！？!?]*$/u, " ")
    .replace(/(最近|最新)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\s|の)+$/u, "")
    .trim();

  if (!query || query.length > GMAIL_SEARCH_MAX_QUERY_LENGTH) {
    return undefined;
  }

  return query;

}

export async function runIntegrationGmailSearchMessagesCapability(
  request: CapabilityInvocationRequest
): Promise<CapabilityInvocationResult> {

  const query = extractGmailSearchQuery(request.query);

  if (!query) {
    return { success: false, errorMessage: "メール検索には空でない検索対象が必要です。" };
  }

  const operation = "search_messages";
  const decision = evaluatePolicyDecision(GMAIL_SERVICE, operation);

  if (decision.decision !== "allow") {
    return { success: false, errorMessage: "このメール検索操作は現在実行できません。" };
  }

  return {
    success: true,
    output: "Gmail で該当するメールを検索します。",
    integrationRequirement: {
      requiresApproval: false,
      policyDecision: decision.decision,
      policyReasonCode: decision.reasonCode,
      riskClass: decision.riskClass,
      action: {
        kind: "integration_action",
        summary: "Gmail でメールを検索する",
        metadata: {
          service: GMAIL_SERVICE,
          operation,
          input: { query, maxResults: GMAIL_SEARCH_DEFAULT_MAX_RESULTS },
        },
      },
    },
  };

}

function extractNotionQuotedPhrase(input: string): string | undefined {
  const patterns = [/(?:\u300c)(.*?)(?:\u300d)/gu, /"(.*?)"/gu, /'(.*?)'/gu];
  const phrases = patterns.flatMap((pattern) =>
    [...input.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean)
  );

  return phrases.length === 1 && phrases[0].length <= GMAIL_SEARCH_MAX_QUERY_LENGTH
    ? phrases[0]
    : undefined;
}

function extractNotionPhrase(input: string): string | undefined {
  const quoted = extractNotionQuotedPhrase(input);

  if (quoted) {
    return quoted;
  }

  const phrase = input
    .replace(/notion|\u30ce\u30fc\u30b7\u30e7\u30f3/giu, " ")
    .replace(/(?:\u304b\u3089|\u3067|\u306e)?(?:\u63a2\u3057\u3066|\u691c\u7d22(?:\u3057\u3066)?|\u8aad\u3093\u3067|\u78ba\u8a8d\u3057\u3066)[^\s]*$/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return phrase && phrase.length <= GMAIL_SEARCH_MAX_QUERY_LENGTH ? phrase : undefined;
}

export function extractNotionSearchQuery(input: string): string | undefined {
  return extractNotionPhrase(input);
}

export function extractNotionReadPageReference(input: string): string | undefined {
  return extractNotionPhrase(input);
}

function readOnlyIntegrationCapability(
  service: string,
  operation: string,
  input: Record<string, unknown>,
  summary: string,
  output: string
): CapabilityInvocationResult {
  const decision = evaluatePolicyDecision(service, operation);

  if (decision.decision !== "allow") {
    return { success: false, errorMessage: "この参照操作は現在利用できません。" };
  }

  return {
    success: true,
    output,
    integrationRequirement: {
      requiresApproval: false,
      policyDecision: decision.decision,
      policyReasonCode: decision.reasonCode,
      riskClass: decision.riskClass,
      action: {
        kind: "integration_action",
        summary,
        metadata: { service, operation, input },
      },
    },
  };
}

export async function runIntegrationNotionSearchCapability(
  request: CapabilityInvocationRequest
): Promise<CapabilityInvocationResult> {
  const query = extractNotionSearchQuery(request.query);

  if (!query) {
    return { success: false, errorMessage: "Notion検索には対象の語句が必要です。" };
  }

  return readOnlyIntegrationCapability(
    NOTION_SERVICE,
    "search",
    { query, maxResults: NOTION_SEARCH_DEFAULT_MAX_RESULTS },
    "Notionを検索する",
    "Notion を検索します。"
  );
}

export async function runIntegrationNotionReadPageCapability(
  request: CapabilityInvocationRequest
): Promise<CapabilityInvocationResult> {
  const pageId = extractNotionReadPageReference(request.query);

  if (!pageId) {
    return { success: false, errorMessage: "Notionページを読むには対象のページ名が必要です。" };
  }

  // The deterministic Slack syntax supplies a title-like page reference.
  // The Composio adapter resolves it only when it is a unique match, then
  // still performs the canonical bounded page read. Callers never supply
  // provider account IDs, connection IDs, or provider parameters.
  return readOnlyIntegrationCapability(
    NOTION_SERVICE,
    "read_page",
    { pageId },
    "Notionページを読む",
    "Notionページを確認します。"
  );
}

// =========================
// TACT Integration — "integration.slack.send_message" /
// "integration.slack.list_channels" Capabilities
// (Architecture Migration Phase C2.1b / C2.2)
// =========================
//
// core/tact-bootstrap.ts(合成ルート)がこれらの関数を
// registerCapability("integration.slack.*", ...)経由でCapability
// Registry(core/tact-core/capabilities/registry.ts)へ登録する。
// core/tact-orchestrator/executor.tsは"research"以外のCapability名に
// 対しては汎用のinvokeCapability()を直接呼ぶため(絶対条件12:
// Capability固有分岐を増やさない)、この関数はcore/tact-research/
// capabilityAdapter.tsのrunResearchCapability()のような変換Adapterを
// 介さず、CapabilityInvocationRequestを直接受け取る。
//
// 絶対条件(最重要、Phase C2.1b指示から継続): このfileはDBアクセス・
// Composio呼び出し・TACT Connection解決のいずれも行わない
// (accessToken自体がCapabilityInvocationRequest/CoreCapabilityの
// どちらにも存在しない——Capability層はTACT Coreの汎用Memory/
// Knowledge抽象しか持たず、Supabase RLS用のper-user access token
// を持たない設計であることをrepository調査で確認済み)。
//
// 絶対条件(Phase C2.2、Read/Write Policy): このfileはcore/tact-work/
// approval.tsのrequestApproval()を直接呼ばず、また「承認が必要か」を
// 自分で判断しない——core/tact-integration/policy.tsのcanonical
// PolicyDecision(Fast Port P2b、evaluatePolicyDecision())を参照し、
// その結果をTaskExecutionSummary.integrationRequirementとしてそのまま
// 運ぶだけにとどめる。実際にConnection解決・Approval作成・(read時の)
// 即時実行を行うのは、accessTokenを実際に持つcore/tact-work/
// execution.ts(runWorkTurn())の責務(絶対条件: 同一intentでTaskを
// 二重作成しない、Approval作成はcore/tact-work側に一元化する)。
//
// Fast Port P2b(docs/architecture/p2-p5-final-architecture.md
// Section5-9): 旧resolveIntegrationActionPolicy()呼び出しは
// evaluatePolicyDecision()へ置き換えた。requiresApprovalは
// policyDecision.decision==="require_approval"からの導出field
// として引き続き運ぶ(後方互換、値は変わらない)——live decisionの
// source of truthはintegrationRequirement.policyDecision(新規field、
// core/tact-orchestrator/task.tsのTaskIntegrationPolicyDecision)。
//
// 絶対条件(Correction2、canonical actionの単一表現): send_message
// (write)・list_channels(read)のいずれも、canonical action
// (service/operation/input)はintegrationRequirement.actionという
// 1箇所だけに表現する。旧approvalRequirement(Phase B3の汎用Approval
// 機構、Integration以外の将来Capabilityも使いうる)は、Integration
// Capability自身はもう使わない——同じaction情報を複数fieldへコピー
// してsource-of-truthを二重化しないため。

const SLACK_SERVICE = "slack";

export async function runIntegrationSlackSendMessageCapability(
  request: CapabilityInvocationRequest
): Promise<CapabilityInvocationResult> {

  // Routing層(core/tact-intent/ruleRouter.tsのclassifyIntent()、
  // core/tact-orchestrator/ambiguityDetector.tsのdetectAmbiguity())が
  // 既にchannel/textの両方を確認済みのはずだが、この関数は独立して
  // 呼ばれうる(Capability Registry経由の直接呼び出し)ため、防御的に
  // 再抽出する。何らかの理由で抽出できない場合も例外を投げず、安全に
  // 失敗として扱う(絶対条件17と同じ精神: Capability呼び出しは
  // 例外を外へ投げない)。
  const extracted = extractSlackSendIntent(request.query);

  if (!extracted.matched || "missing" in extracted) {

    return {
      success: false,
      errorMessage:
        "Slack送信に必要なchannel/textを特定できませんでした(routing層と結果が一致しません)。",
    };

  }

  const { channel, text } = extracted;

  const operation = "send_message";

  // Fast Port P2b(絶対条件、Correction1を継承): policy allowlistに
  // 登録されていないactionは、たとえこの関数自体が呼ばれても実行可能
  // 扱いにしない(fail-closed)。send_messageはpolicy.ts上
  // require_approval(riskClass="write")として登録済みのため、通常
  // この分岐には到達しない——将来policy.ts側の登録が変更された場合に
  // 備えた防御的チェック(この関数はsend_message専用であり、
  // require_approval以外の値(allow/require_input/deny)はすべて
  // 「現在サポートされていない」として同じ扱いにする——複数のdecision
  // 値を個別に解釈しない、単一目的Capabilityとしての単純さを維持)。
  const decision = evaluatePolicyDecision(SLACK_SERVICE, operation);

  if (decision.decision !== "require_approval") {

    return {
      success: false,
      errorMessage: "この操作は現在サポートされていません。",
    };

  }

  return {

    success: true,

    // このTurnの回答として表示される。Connection解決前の時点では
    // 「承認が必要」であることまでしか断定できない(0件/複数件の場合の
    // 案内はcore/tact-work/execution.ts側がConnection解決後に
    // result.answerを上書きする、既存のOrchestrationResult変更なし
    // では表現しきれないため)。
    output: `Slack「${channel}」チャンネルへメッセージを送信する準備ができました。承認をお願いします。`,

    // Architecture Migration Phase C2.2: canonical actionをここ1箇所
    // だけで表現する(Correction2、旧approvalRequirementは使わない)。
    integrationRequirement: {

      // Fast Port P2b: requiresApprovalは後方互換のための導出field
      // (decision.decision==="require_approval"と常に同値)。
      requiresApproval: true,

      // Fast Port P2b: live decisionのsource of truth。
      // core/tact-work/execution.tsのonTaskFinished()はこの値で
      // exhaustive switchする。
      policyDecision: decision.decision,

      // Fast Port P4b: policy.evaluated Audit Eventのreason_code列へ
      // そのまま渡すためだけの値。
      policyReasonCode: decision.reasonCode,

      reason: "外部SaaS(Slack)への投稿には承認が必要です",

      // Architecture Migration ARCH-P1b: このrequirementを判定した
      // 時点のcanonical risk classificationをそのまま運ぶ(Approval
      // Subject.riskClassSnapshotの唯一のsource、
      // docs/architecture/approval-integrity.md Step4参照)。
      riskClass: decision.riskClass,

      action: {

        kind: "integration_action",

        summary: `Slack「${channel}」チャンネルへメッセージを送信します`,

        // Provider固有の識別子(Composio tool slug/connectedAccountId等)
        // は一切含まない——canonical actionのみ(絶対条件)。
        // connectionIdはまだ含めない(core/tact-work/execution.tsが
        // Connection解決後に追加する)。
        metadata: {
          service: SLACK_SERVICE,
          operation,
          input: { channel, text },
        },

      },

    },

  };

}

// =========================
// "integration.slack.list_channels" (Architecture Migration Phase C2.2)
// =========================
//
// read-only capability。入力はSlackワークスペース全体が対象のため
// 必須fieldを持たない({}、ユーザー指示Section6)。channel名等の
// provider都合のfieldをcanonical inputへ追加しない。requestからの
// 抽出が不要なため、引数自体を持たない(呼び出し側はCapabilityHandler/
// invokeCapability()経由でrequestを渡すが、この関数は使わないだけ
// ——既存のdefaultResolveIntegrationConnection()と同じ既存パターン)。
export async function runIntegrationSlackListChannelsCapability(): Promise<CapabilityInvocationResult> {

  const operation = "list_channels";

  const decision = evaluatePolicyDecision(SLACK_SERVICE, operation);

  // Fast Port P2b(絶対条件、Correction1を継承): decisionが"allow"以外
  // (未登録/require_approval/require_input/deny)の場合、
  // requiresApproval=trueへ安全側fallbackせず「実行そのものを拒否
  // する」。通常この分岐には到達しない(list_channelsはpolicy.ts上
  // allow(riskClass="read")として登録済み)が、将来policy.ts側の
  // 登録が変更された場合に備えた防御的チェック(この関数はread専用
  // Capabilityであり、allow以外はすべて同じ「サポートされていない」
  // 扱いにする)。
  if (decision.decision !== "allow") {

    return {
      success: false,
      errorMessage: "この操作は現在サポートされていません。",
    };

  }

  return {

    success: true,

    output: "Slackのチャンネル一覧を取得する準備ができました。",

    integrationRequirement: {

      // decision.decision==="allow"のため常にfalse
      // (evaluatePolicyDecision()から導出済みの値をそのまま運ぶ、
      // このfile自身は「readだから承認不要」という判断を独自にしない)。
      requiresApproval: false,

      // Fast Port P2b: live decisionのsource of truth。
      policyDecision: decision.decision,

      // Fast Port P4b: policy.evaluated Audit Eventのreason_code列へ
      // そのまま渡すためだけの値。
      policyReasonCode: decision.reasonCode,

      // Architecture Migration ARCH-P1b: readはApprovalを一切経由
      // しない(絶対条件Correction2)ためriskClassSnapshotが実際に
      // 使われることはないが、writeと同じ形で一貫して運んでおく。
      riskClass: decision.riskClass,

      action: {

        kind: "integration_action",

        summary: "Slackのチャンネル一覧を取得します",

        metadata: {
          service: SLACK_SERVICE,
          operation,
          input: {},
        },

      },

    },

  };

}
